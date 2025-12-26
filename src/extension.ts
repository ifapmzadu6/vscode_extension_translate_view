import * as vscode from 'vscode';

// Constants for message types
const MessageType = {
    ChangeLanguage: 'changeLanguage',
    Ready: 'ready',
    Update: 'update',
    Loading: 'loading',
    Error: 'error',
    Scroll: 'scroll',
} as const;

interface IncomingMessage {
    type: string;
    language?: string;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Translation error occurred';
}

const LANGUAGE_NAMES: { [key: string]: string } = {
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

async function translate(content: string, targetLanguage: string): Promise<string> {
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
        throw new Error('No language model available. Please install GitHub Copilot or another language model extension.');
    }

    const targetLangName = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
    const prompt = `Translate the following Markdown content to ${targetLangName}. Keep the Markdown formatting intact. Only translate the text content, not the Markdown syntax or code blocks. Output only the translated content without any explanation.

${content}`;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const cancellationTokenSource = new vscode.CancellationTokenSource();

    try {
        const response = await models[0].sendRequest(messages, {}, cancellationTokenSource.token);
        // Use array and join for better performance with large responses
        const chunks: string[] = [];
        for await (const chunk of response.text) {
            chunks.push(chunk);
        }
        return chunks.join('') || content;
    } finally {
        cancellationTokenSource.dispose();
    }
}

class TranslateViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'translateView.webview';
    private _view?: vscode.WebviewView;
    private _currentDocument?: vscode.TextDocument;
    private _debounceTimer?: ReturnType<typeof setTimeout>;
    private _isTranslating = false;
    private _pendingDocument?: vscode.TextDocument;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public dispose(): void {
        this.clearDebounceTimer();
    }

    private clearDebounceTimer(): void {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data: IncomingMessage) => {
            if (data.type === MessageType.ChangeLanguage && data.language) {
                await vscode.workspace.getConfiguration('translateView').update('targetLanguage', data.language, vscode.ConfigurationTarget.Global);
                if (this._currentDocument) {
                    this.updateContent(this._currentDocument);
                }
            } else if (data.type === MessageType.Ready) {
                if (vscode.window.activeTextEditor?.document.languageId === 'markdown') {
                    this.updateContent(vscode.window.activeTextEditor.document);
                }
            }
        });
    }

    public async updateContent(document: vscode.TextDocument): Promise<void> {
        if (!this._view) {
            return;
        }
        this._currentDocument = document;

        // If translation is in progress, save as pending and return
        if (this._isTranslating) {
            this._pendingDocument = document;
            return;
        }

        this.clearDebounceTimer();

        this._debounceTimer = setTimeout(() => {
            this._executeTranslation(document).catch((error: unknown) => {
                this._view?.webview.postMessage({ type: MessageType.Error, message: getErrorMessage(error) });
            });
        }, 500);
    }

    private async _executeTranslation(document: vscode.TextDocument): Promise<void> {
        if (!this._view) {
            return;
        }

        this._isTranslating = true;
        this._pendingDocument = undefined;

        const content = document.getText();
        const targetLanguage = vscode.workspace.getConfiguration('translateView').get<string>('targetLanguage') || 'ja';

        this._view.webview.postMessage({ type: MessageType.Loading });

        try {
            const translatedContent = await translate(content, targetLanguage);
            this._view?.webview.postMessage({ type: MessageType.Update, content: translatedContent, language: targetLanguage });
        } catch (error) {
            this._view?.webview.postMessage({ type: MessageType.Error, message: getErrorMessage(error) });
        } finally {
            this._isTranslating = false;

            // If there's a pending document, translate it now
            if (this._pendingDocument) {
                const pending = this._pendingDocument;
                this._pendingDocument = undefined;
                await this._executeTranslation(pending);
            }
        }
    }

    public syncScroll(lineNumber: number): void {
        this._view?.webview.postMessage({ type: MessageType.Scroll, line: lineNumber });
    }

    private _getHtml(webview: vscode.Webview): string {
        const nonce = Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); line-height: 1.5; }
        .header { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background-color: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); z-index: 10; }
        .title { font-weight: bold; font-size: 12px; }
        .language-selector { display: flex; align-items: center; gap: 8px; }
        .globe-icon { cursor: pointer; font-size: 16px; opacity: 0.8; transition: opacity 0.2s; }
        .globe-icon:hover { opacity: 1; }
        .language-dropdown { position: relative; display: inline-block; }
        .dropdown-content { display: none; position: absolute; right: 0; background-color: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; min-width: 120px; z-index: 100; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
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
    <div class="header">
        <span class="title">Translation</span>
        <div class="language-selector">
            <span id="currentLang">日本語</span>
            <div class="language-dropdown">
                <span class="globe-icon" id="globeIcon">🌐</span>
                <div class="dropdown-content" id="dropdown"></div>
            </div>
        </div>
    </div>
    <div class="content" id="content"><span class="placeholder">Please open a Markdown file</span></div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            const content = document.getElementById('content');
            const dropdown = document.getElementById('dropdown');
            const globeIcon = document.getElementById('globeIcon');
            const currentLang = document.getElementById('currentLang');
            const langs = { 'en': 'English', 'ja': '日本語', 'zh-hans': '中文（简体）', 'zh-hant': '中文（繁體）', 'ko': '한국어', 'de': 'Deutsch', 'fr': 'Français', 'es': 'Español', 'it': 'Italiano', 'pt-br': 'Português (Brasil)', 'ru': 'Русский' };
            let selectedLanguage = 'ja';

            // Build line elements map for efficient lookup
            const lineElements = new Map();

            Object.entries(langs).forEach(function(entry) {
                const lang = entry[0];
                const name = entry[1];
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.dataset.lang = lang;
                item.textContent = name;
                item.addEventListener('click', function() {
                    selectedLanguage = lang;
                    currentLang.textContent = name;
                    dropdown.classList.remove('show');
                    vscode.postMessage({ type: 'changeLanguage', language: lang });
                });
                dropdown.appendChild(item);
            });

            globeIcon.addEventListener('click', function(e) {
                e.stopPropagation();
                dropdown.classList.toggle('show');
                document.querySelectorAll('.dropdown-item').forEach(function(item) {
                    item.classList.toggle('selected', item.dataset.lang === selectedLanguage);
                });
            });
            document.addEventListener('click', function() {
                dropdown.classList.remove('show');
            });

            window.addEventListener('message', function(event) {
                const msg = event.data;
                if (msg.type === 'update') {
                    // Clear line elements map
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
                        currentLang.textContent = langs[msg.language] || msg.language;
                    }
                } else if (msg.type === 'loading') {
                    content.innerHTML = '<div class="loading"><div class="spinner"></div><span>Translating...</span></div>';
                } else if (msg.type === 'error') {
                    // Safe error display without innerHTML injection
                    content.innerHTML = '';
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'error';
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

let provider: TranslateViewProvider;

export function activate(context: vscode.ExtensionContext): void {
    provider = new TranslateViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TranslateViewProvider.viewType, provider),
        vscode.commands.registerCommand('translateView.open', () => vscode.commands.executeCommand('translateView.webview.focus')),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor?.document.languageId === 'markdown') {
                provider.updateContent(editor.document);
            }
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document && event.document.languageId === 'markdown') {
                provider.updateContent(event.document);
            }
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (event.textEditor.document.languageId === 'markdown' && event.visibleRanges.length > 0) {
                provider.syncScroll(event.visibleRanges[0].start.line);
            }
        }),
        { dispose: () => provider.dispose() }
    );

    if (vscode.window.activeTextEditor?.document.languageId === 'markdown') {
        provider.updateContent(vscode.window.activeTextEditor.document);
    }
}

export function deactivate(): void {
    provider?.dispose();
}
