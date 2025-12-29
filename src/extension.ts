import * as vscode from 'vscode';
import * as crypto from 'crypto';

// Constants
const DEBOUNCE_DELAY_MS = 500;
const DEFAULT_LANGUAGE = 'ja';
const MARKDOWN_LANGUAGE_ID = 'markdown';

// Valid language codes from package.json configuration
const VALID_LANGUAGES = ['en', 'ja', 'zh-hans', 'zh-hant', 'ko', 'de', 'fr', 'es', 'it', 'pt-br', 'ru'] as const;
type ValidLanguage = typeof VALID_LANGUAGES[number];

// Constants for message types
const MessageType = {
    ChangeLanguage: 'changeLanguage',
    Ready: 'ready',
    Update: 'update',
    Loading: 'loading',
    Error: 'error',
    Scroll: 'scroll',
    StreamingStart: 'streamingStart',
    StreamingChunk: 'streamingChunk',
    StreamingEnd: 'streamingEnd',
} as const;

type MessageTypeValue = typeof MessageType[keyof typeof MessageType];

/** Message received from webview */
interface IncomingMessage {
    type: typeof MessageType.ChangeLanguage | typeof MessageType.Ready;
    language?: string;
}

/** Message sent to webview */
interface OutgoingMessage {
    type: MessageTypeValue;
    content?: string;
    message?: string;
    language?: string;
    line?: number;
}

/**
 * Extracts error message from unknown error type
 */
function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Translation error occurred';
}

/**
 * Validates if a language code is valid
 */
function isValidLanguage(lang: string): lang is ValidLanguage {
    return VALID_LANGUAGES.includes(lang as ValidLanguage);
}

/**
 * Generates a cryptographically secure nonce for CSP
 */
function generateNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

const LANGUAGE_NAMES: Record<ValidLanguage, string> = {
    'en': 'English',
    'ja': 'Japanese',
    'zh-hans': 'Simplified Chinese',
    'zh-hant': 'Traditional Chinese',
    'ko': 'Korean',
    'de': 'German',
    'fr': 'French',
    'es': 'Spanish',
    'it': 'Italian',
    'pt-br': 'Brazilian Portuguese',
    'ru': 'Russian'
};

// Cached model for performance
let cachedModel: vscode.LanguageModelChat | undefined;

/**
 * Callback type for streaming translation chunks
 */
type StreamingCallback = (chunk: string) => void;

/**
 * Translates Markdown content to the target language using VSCode Language Model API with streaming support
 * @param content - The Markdown content to translate
 * @param targetLanguage - Target language code (e.g., 'ja', 'en')
 * @param onChunk - Optional callback function called for each chunk received
 * @returns Translated content or throws an error if translation fails
 */
async function translate(content: string, targetLanguage: string, onChunk?: StreamingCallback): Promise<string> {
    // Use cached model if available, otherwise select and cache
    if (!cachedModel) {
        const models = await vscode.lm.selectChatModels();
        if (models.length === 0) {
            throw new Error('No language model available. Please install GitHub Copilot or another language model extension.');
        }
        cachedModel = models[0];
    }

    const targetLangName = LANGUAGE_NAMES[targetLanguage as ValidLanguage] || targetLanguage;
    const prompt = `Translate the following Markdown content to ${targetLangName}. Keep the Markdown formatting intact. Only translate the text content, not the Markdown syntax or code blocks. Output only the translated content without any explanation.

${content}`;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const cancellationTokenSource = new vscode.CancellationTokenSource();

    try {
        const response = await cachedModel.sendRequest(messages, {}, cancellationTokenSource.token);
        const chunks: string[] = [];
        for await (const chunk of response.text) {
            chunks.push(chunk);
            // Call streaming callback if provided
            if (onChunk) {
                onChunk(chunk);
            }
        }
        const result = chunks.join('');
        if (!result) {
            console.warn('[TranslateView] Translation returned empty result, using original content');
        }
        return result || content;
    } catch (error) {
        // Clear cached model on error in case the model became unavailable
        if (error instanceof Error && error.message.includes('model')) {
            cachedModel = undefined;
        }
        throw error;
    } finally {
        cancellationTokenSource.dispose();
    }
}

/**
 * Provides the translation webview for the secondary sidebar
 */
class TranslateViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'translateView.view';
    private static _instance: TranslateViewProvider | undefined;

    private _view?: vscode.WebviewView;
    private _currentDocument?: vscode.TextDocument;
    private _debounceTimer?: ReturnType<typeof setTimeout>;
    private _isTranslating = false;
    private _pendingDocument?: vscode.TextDocument;

    constructor(private readonly _extensionUri: vscode.Uri) {
        TranslateViewProvider._instance = this;
    }

    public static getInstance(): TranslateViewProvider | undefined {
        return TranslateViewProvider._instance;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data: IncomingMessage) => {
            if (data.type === MessageType.ChangeLanguage && data.language) {
                if (!isValidLanguage(data.language)) {
                    console.error(`[TranslateView] Invalid language code received: ${data.language}`);
                    return;
                }
                await vscode.workspace.getConfiguration('translateView').update('targetLanguage', data.language, vscode.ConfigurationTarget.Global);
                if (this._currentDocument) {
                    this.updateContent(this._currentDocument);
                }
            } else if (data.type === MessageType.Ready) {
                const editor = vscode.window.activeTextEditor;
                if (editor?.document.languageId === MARKDOWN_LANGUAGE_ID) {
                    this.updateContent(editor.document);
                }
            }
        });

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });

        // If there's already an active markdown editor, update content
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.languageId === MARKDOWN_LANGUAGE_ID) {
            this.updateContent(editor.document);
        }
    }

    public show(): void {
        if (this._view) {
            this._view.show?.(true);
        }
    }

    private clearDebounceTimer(): void {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }
    }

    private postMessage(message: OutgoingMessage): void {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public async updateContent(document: vscode.TextDocument): Promise<void> {
        this._currentDocument = document;

        if (this._isTranslating) {
            this._pendingDocument = document;
            return;
        }

        this.clearDebounceTimer();

        this._debounceTimer = setTimeout(() => {
            this._executeTranslation(document).catch((error: unknown) => {
                console.error('[TranslateView] Translation failed:', error);
                this.postMessage({ type: MessageType.Error, message: getErrorMessage(error) });
            });
        }, DEBOUNCE_DELAY_MS);
    }

    private async _executeTranslation(document: vscode.TextDocument): Promise<void> {
        this._isTranslating = true;
        this._pendingDocument = undefined;

        const content = document.getText();
        const configuredLanguage = vscode.workspace.getConfiguration('translateView').get<string>('targetLanguage');
        const targetLanguage = (configuredLanguage && isValidLanguage(configuredLanguage)) ? configuredLanguage : DEFAULT_LANGUAGE;

        // Send streaming start message
        this.postMessage({ type: MessageType.StreamingStart, language: targetLanguage });

        try {
            // Use streaming callback to send chunks as they arrive
            const translatedContent = await translate(content, targetLanguage, (chunk: string) => {
                this.postMessage({ type: MessageType.StreamingChunk, content: chunk });
            });

            // Send streaming end message with final content for fallback
            this.postMessage({ type: MessageType.StreamingEnd, content: translatedContent, language: targetLanguage });
        } catch (error) {
            console.error('[TranslateView] Translation error:', error);
            this.postMessage({ type: MessageType.Error, message: getErrorMessage(error) });
        } finally {
            this._isTranslating = false;

            if (this._pendingDocument) {
                const pending = this._pendingDocument;
                this._pendingDocument = undefined;
                await this._executeTranslation(pending);
            }
        }
    }

    public syncScroll(lineNumber: number): void {
        this.postMessage({ type: MessageType.Scroll, line: lineNumber });
    }

    private _getHtml(webview: vscode.Webview): string {
        const nonce = generateNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); line-height: 1.5; }
        .floating-language-selector { position: fixed; bottom: 16px; right: 16px; z-index: 1000; }
        .globe-icon { cursor: pointer; font-size: 20px; opacity: 0.7; transition: all 0.2s; background-color: var(--vscode-button-background); border-radius: 50%; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
        .globe-icon:hover { opacity: 1; transform: scale(1.1); box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
        .dropdown-content { display: none; position: absolute; bottom: 50px; right: 0; background-color: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; min-width: 160px; z-index: 100; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
        .dropdown-content.show { display: block; }
        .dropdown-item { padding: 6px 12px; cursor: pointer; font-size: 12px; color: var(--vscode-dropdown-foreground); }
        .dropdown-item:hover { background-color: var(--vscode-list-hoverBackground); }
        .dropdown-item.selected { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .content { padding: 12px; }
        .line { white-space: pre-wrap; word-wrap: break-word; min-height: 1.5em; scroll-margin-top: 40px; }
        .loading { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); padding: 20px 12px; }
        .spinner { width: 14px; height: 14px; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error { color: var(--vscode-errorForeground); padding: 12px; background-color: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 4px; margin: 12px; }
        .placeholder { color: var(--vscode-descriptionForeground); font-style: italic; padding: 20px 12px; }
    </style>
</head>
<body>
    <div class="content" id="content" role="region" aria-label="Translated content" aria-live="polite"><span class="placeholder">Please open a Markdown file</span></div>
    <div class="floating-language-selector">
        <span class="globe-icon" id="globeIcon" role="button" tabindex="0" aria-label="Change translation language" aria-haspopup="listbox" aria-expanded="false">🌐</span>
        <div class="dropdown-content" id="dropdown" role="listbox" aria-label="Select language"></div>
    </div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            const content = document.getElementById('content');
            const dropdown = document.getElementById('dropdown');
            const globeIcon = document.getElementById('globeIcon');
            const langs = { 'en': 'English', 'ja': '日本語', 'zh-hans': '中文（简体）', 'zh-hant': '中文（繁體）', 'ko': '한국어', 'de': 'Deutsch', 'fr': 'Français', 'es': 'Español', 'it': 'Italiano', 'pt-br': 'Português (Brasil)', 'ru': 'Русский' };
            let selectedLanguage = 'ja';
            let focusedIndex = -1;
            const langKeys = Object.keys(langs);

            // Build line elements map for efficient lookup
            const lineElements = new Map();

            // Streaming state
            let streamingBuffer = '';
            let isStreaming = false;

            // Render streaming content - updates display with current buffer
            function renderStreamingContent() {
                lineElements.clear();
                const fragment = document.createDocumentFragment();
                const lines = streamingBuffer.split('\\n');
                lines.forEach(function(line, i) {
                    const div = document.createElement('div');
                    div.className = 'line';
                    div.dataset.line = i.toString();
                    div.textContent = line;
                    lineElements.set(i, div);
                    fragment.appendChild(div);
                });
                content.innerHTML = '';
                content.appendChild(fragment);
            }

            function selectLanguage(lang, name) {
                selectedLanguage = lang;
                closeDropdown();
                vscode.postMessage({ type: 'changeLanguage', language: lang });
            }

            function openDropdown() {
                dropdown.classList.add('show');
                globeIcon.setAttribute('aria-expanded', 'true');
                document.querySelectorAll('.dropdown-item').forEach(function(item) {
                    const isSelected = item.dataset.lang === selectedLanguage;
                    item.classList.toggle('selected', isSelected);
                    item.setAttribute('aria-selected', isSelected.toString());
                });
                focusedIndex = langKeys.indexOf(selectedLanguage);
                if (focusedIndex >= 0) {
                    dropdown.children[focusedIndex].focus();
                }
            }

            function closeDropdown() {
                dropdown.classList.remove('show');
                globeIcon.setAttribute('aria-expanded', 'false');
                focusedIndex = -1;
            }

            function toggleDropdown() {
                if (dropdown.classList.contains('show')) {
                    closeDropdown();
                } else {
                    openDropdown();
                }
            }

            Object.entries(langs).forEach(function(entry) {
                const lang = entry[0];
                const name = entry[1];
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.dataset.lang = lang;
                item.textContent = name;
                item.setAttribute('role', 'option');
                item.setAttribute('tabindex', '-1');
                item.addEventListener('click', function() {
                    selectLanguage(lang, name);
                });
                item.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectLanguage(lang, name);
                    }
                });
                dropdown.appendChild(item);
            });

            globeIcon.addEventListener('click', function(e) {
                e.stopPropagation();
                toggleDropdown();
            });

            globeIcon.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleDropdown();
                } else if (e.key === 'ArrowDown' && !dropdown.classList.contains('show')) {
                    e.preventDefault();
                    openDropdown();
                }
            });

            dropdown.addEventListener('keydown', function(e) {
                const items = dropdown.querySelectorAll('.dropdown-item');
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    focusedIndex = (focusedIndex + 1) % items.length;
                    items[focusedIndex].focus();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    focusedIndex = (focusedIndex - 1 + items.length) % items.length;
                    items[focusedIndex].focus();
                } else if (e.key === 'Escape') {
                    closeDropdown();
                    globeIcon.focus();
                } else if (e.key === 'Home') {
                    e.preventDefault();
                    focusedIndex = 0;
                    items[focusedIndex].focus();
                } else if (e.key === 'End') {
                    e.preventDefault();
                    focusedIndex = items.length - 1;
                    items[focusedIndex].focus();
                }
            });

            document.addEventListener('click', function() {
                closeDropdown();
            });

            window.addEventListener('message', function(event) {
                const msg = event.data;
                if (msg.type === 'streamingStart') {
                    // Start streaming: reset buffer and show initial state
                    streamingBuffer = '';
                    isStreaming = true;
                    content.innerHTML = '<div class="loading" role="status" aria-label="Translating"><div class="spinner"></div><span>Translating...</span></div>';
                    if (msg.language) {
                        selectedLanguage = msg.language;
                    }
                } else if (msg.type === 'streamingChunk') {
                    // Append chunk to buffer and re-render
                    if (isStreaming) {
                        streamingBuffer += msg.content;
                        renderStreamingContent();
                    }
                } else if (msg.type === 'streamingEnd') {
                    // Streaming complete: finalize display
                    isStreaming = false;
                    if (msg.content) {
                        streamingBuffer = msg.content;
                        renderStreamingContent();
                    }
                    if (msg.language) {
                        selectedLanguage = msg.language;
                    }
                } else if (msg.type === 'update') {
                    // Legacy update (non-streaming): Clear line elements map
                    lineElements.clear();
                    // Use DocumentFragment for efficient DOM updates
                    const fragment = document.createDocumentFragment();
                    const lines = msg.content.split('\\n');
                    lines.forEach(function(line, i) {
                        const div = document.createElement('div');
                        div.className = 'line';
                        div.dataset.line = i.toString();
                        div.textContent = line;
                        lineElements.set(i, div);
                        fragment.appendChild(div);
                    });
                    content.innerHTML = '';
                    content.appendChild(fragment);
                    if (msg.language) {
                        selectedLanguage = msg.language;
                    }
                } else if (msg.type === 'loading') {
                    content.innerHTML = '<div class="loading" role="status" aria-label="Translating"><div class="spinner"></div><span>Translating...</span></div>';
                } else if (msg.type === 'error') {
                    // Safe error display without innerHTML injection
                    content.innerHTML = '';
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'error';
                    errorDiv.setAttribute('role', 'alert');
                    errorDiv.textContent = msg.message;
                    content.appendChild(errorDiv);
                } else if (msg.type === 'scroll') {
                    const target = lineElements.get(msg.line);
                    if (target) {
                        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }
            });

            vscode.postMessage({ type: 'ready' });
        })();
    </script>
</body>
</html>`;
    }
}

/**
 * Activates the extension
 * Called when a Markdown file is opened
 */
export function activate(context: vscode.ExtensionContext): void {
    // Create and register the webview view provider
    const provider = new TranslateViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TranslateViewProvider.viewType, provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );

    // Register the command to open/show the translate view
    context.subscriptions.push(
        vscode.commands.registerCommand('translateView.open', () => {
            vscode.commands.executeCommand('workbench.view.extension.translateViewContainer');
        })
    );

    // Auto-update when active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            const instance = TranslateViewProvider.getInstance();
            if (instance && editor?.document.languageId === MARKDOWN_LANGUAGE_ID) {
                instance.updateContent(editor.document);
            }
        })
    );

    // Auto-update when document content changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const instance = TranslateViewProvider.getInstance();
            const editor = vscode.window.activeTextEditor;
            if (instance && editor && event.document === editor.document && event.document.languageId === MARKDOWN_LANGUAGE_ID) {
                instance.updateContent(event.document);
            }
        })
    );

    // Sync scroll position
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            const instance = TranslateViewProvider.getInstance();
            if (instance && event.textEditor.document.languageId === MARKDOWN_LANGUAGE_ID && event.visibleRanges.length > 0) {
                instance.syncScroll(event.visibleRanges[0].start.line);
            }
        })
    );
}

/**
 * Deactivates the extension
 */
export function deactivate(): void {
    cachedModel = undefined;
}
