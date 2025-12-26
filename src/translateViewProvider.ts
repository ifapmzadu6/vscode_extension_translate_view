import * as vscode from 'vscode';
import { TranslateService } from './translateService';

export class TranslateViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'translateView.webview';

    private _view?: vscode.WebviewView;
    private _translateService: TranslateService;
    private _currentDocument?: vscode.TextDocument;
    private _debounceTimer?: NodeJS.Timeout;

    constructor(private readonly _extensionUri: vscode.Uri) {
        this._translateService = new TranslateService();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'changeLanguage':
                    await vscode.workspace.getConfiguration('translateView')
                        .update('targetLanguage', data.language, vscode.ConfigurationTarget.Global);
                    if (this._currentDocument) {
                        this.updateContent(this._currentDocument);
                    }
                    break;
                case 'ready':
                    if (vscode.window.activeTextEditor?.document.languageId === 'markdown') {
                        this.updateContent(vscode.window.activeTextEditor.document);
                    }
                    break;
            }
        });
    }

    public async updateContent(document: vscode.TextDocument) {
        if (!this._view) {
            return;
        }

        this._currentDocument = document;

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._debounceTimer = setTimeout(async () => {
            const content = document.getText();
            const targetLanguage = vscode.workspace.getConfiguration('translateView').get<string>('targetLanguage') || 'ja';

            this._view!.webview.postMessage({
                type: 'loading'
            });

            try {
                const translatedContent = await this._translateService.translate(content, targetLanguage);

                this._view!.webview.postMessage({
                    type: 'update',
                    content: translatedContent,
                    language: targetLanguage
                });
            } catch (error) {
                this._view!.webview.postMessage({
                    type: 'error',
                    message: error instanceof Error ? error.message : 'Translation error occurred'
                });
            }
        }, 500);
    }

    public syncScroll(lineNumber: number) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'scroll',
                line: lineNumber
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translate View</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.5;
        }
        .header {
            position: sticky;
            top: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            z-index: 10;
        }
        .title {
            font-weight: bold;
            font-size: 12px;
        }
        .language-selector {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .globe-icon {
            cursor: pointer;
            font-size: 16px;
            opacity: 0.8;
            transition: opacity 0.2s;
        }
        .globe-icon:hover {
            opacity: 1;
        }
        .language-dropdown {
            position: relative;
            display: inline-block;
        }
        .dropdown-content {
            display: none;
            position: absolute;
            right: 0;
            background-color: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            min-width: 120px;
            z-index: 100;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }
        .dropdown-content.show {
            display: block;
        }
        .dropdown-item {
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            color: var(--vscode-dropdown-foreground);
        }
        .dropdown-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .dropdown-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .content {
            padding: 12px;
        }
        .line {
            white-space: pre-wrap;
            word-wrap: break-word;
            min-height: 1.5em;
            scroll-margin-top: 40px;
        }
        .loading {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-descriptionForeground);
            padding: 20px 12px;
        }
        .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-progressBar-background);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .error {
            color: var(--vscode-errorForeground);
            padding: 12px;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 4px;
            margin: 12px;
        }
        .placeholder {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 20px 12px;
        }
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
    <div class="content" id="content">
        <span class="placeholder">Please open a Markdown file</span>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const content = document.getElementById('content');
        const dropdown = document.getElementById('dropdown');
        const globeIcon = document.getElementById('globeIcon');
        const currentLang = document.getElementById('currentLang');

        const languageNames = {
            'en': 'English',
            'ja': '日本語',
            'zh-hans': '中文（简体）',
            'zh-hant': '中文（繁體）',
            'ko': '한국어',
            'de': 'Deutsch',
            'fr': 'Français',
            'es': 'Español',
            'it': 'Italiano',
            'pt-br': 'Português (Brasil)',
            'ru': 'Русский'
        };

        let selectedLanguage = 'ja';

        Object.entries(languageNames).forEach(([lang, name]) => {
            const item = document.createElement('div');
            item.className = 'dropdown-item';
            item.dataset.lang = lang;
            item.textContent = name;
            item.addEventListener('click', () => {
                selectedLanguage = lang;
                currentLang.textContent = name;
                dropdown.classList.remove('show');
                vscode.postMessage({ type: 'changeLanguage', language: lang });
            });
            dropdown.appendChild(item);
        });

        globeIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('show');
            updateDropdownSelection();
        });

        document.addEventListener('click', () => {
            dropdown.classList.remove('show');
        });

        function updateDropdownSelection() {
            document.querySelectorAll('.dropdown-item').forEach(item => {
                item.classList.toggle('selected', item.dataset.lang === selectedLanguage);
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'update':
                    content.innerHTML = '';
                    const lines = message.content.split('\\n');
                    lines.forEach((line, index) => {
                        const div = document.createElement('div');
                        div.className = 'line';
                        div.dataset.line = index.toString();
                        div.textContent = line;
                        content.appendChild(div);
                    });
                    if (message.language) {
                        selectedLanguage = message.language;
                        currentLang.textContent = languageNames[message.language] || message.language;
                    }
                    break;
                case 'loading':
                    content.innerHTML = '<div class="loading"><div class="spinner"></div><span>Translating...</span></div>';
                    break;
                case 'error':
                    content.innerHTML = '<div class="error">' + escapeHtml(message.message) + '</div>';
                    break;
                case 'scroll':
                    const target = document.querySelector('[data-line="' + message.line + '"]');
                    if (target) {
                        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                    break;
            }
        });

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
