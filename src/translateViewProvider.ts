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
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // WebViewからのメッセージを処理
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

        // デバウンス処理
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        this._debounceTimer = setTimeout(async () => {
            const content = document.getText();
            const targetLanguage = vscode.workspace.getConfiguration('translateView').get<string>('targetLanguage') || 'ja';

            this._view!.webview.postMessage({
                type: 'loading',
                message: '翻訳中...'
            });

            try {
                const translatedContent = await this._translateService.translate(content, targetLanguage);

                this._view!.webview.postMessage({
                    type: 'update',
                    content: translatedContent,
                    originalContent: content,
                    language: targetLanguage
                });
            } catch (error) {
                this._view!.webview.postMessage({
                    type: 'error',
                    message: error instanceof Error ? error.message : '翻訳エラーが発生しました'
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
<html lang="ja">
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
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 10px;
            line-height: 1.6;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 16px;
        }
        .title {
            font-weight: bold;
            font-size: 14px;
        }
        .language-selector {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .globe-icon {
            cursor: pointer;
            font-size: 18px;
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
            z-index: 1;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }
        .dropdown-content.show {
            display: block;
        }
        .dropdown-item {
            padding: 8px 12px;
            cursor: pointer;
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
            padding: 8px 0;
        }
        .content h1 { font-size: 1.8em; margin: 16px 0 8px; }
        .content h2 { font-size: 1.5em; margin: 14px 0 7px; }
        .content h3 { font-size: 1.3em; margin: 12px 0 6px; }
        .content h4 { font-size: 1.1em; margin: 10px 0 5px; }
        .content p { margin: 8px 0; }
        .content ul, .content ol { margin: 8px 0; padding-left: 24px; }
        .content li { margin: 4px 0; }
        .content code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        .content pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 12px 0;
        }
        .content pre code {
            padding: 0;
            background: none;
        }
        .content blockquote {
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding-left: 12px;
            margin: 12px 0;
            color: var(--vscode-textBlockQuote-foreground);
        }
        .content a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .content a:hover {
            text-decoration: underline;
        }
        .loading {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-descriptionForeground);
            padding: 20px;
        }
        .spinner {
            width: 16px;
            height: 16px;
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
            margin: 12px 0;
        }
        .placeholder {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 20px;
            text-align: center;
        }
        [data-line] {
            scroll-margin-top: 20px;
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
                <div class="dropdown-content" id="dropdown">
                    <div class="dropdown-item" data-lang="ja">日本語</div>
                    <div class="dropdown-item" data-lang="en">English</div>
                    <div class="dropdown-item" data-lang="zh">中文</div>
                    <div class="dropdown-item" data-lang="ko">한국어</div>
                    <div class="dropdown-item" data-lang="es">Español</div>
                    <div class="dropdown-item" data-lang="fr">Français</div>
                    <div class="dropdown-item" data-lang="de">Deutsch</div>
                </div>
            </div>
        </div>
    </div>
    <div class="content" id="content">
        <div class="placeholder">Markdownファイルを開いてください</div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const content = document.getElementById('content');
        const dropdown = document.getElementById('dropdown');
        const globeIcon = document.getElementById('globeIcon');
        const currentLang = document.getElementById('currentLang');

        const languageNames = {
            'ja': '日本語',
            'en': 'English',
            'zh': '中文',
            'ko': '한국어',
            'es': 'Español',
            'fr': 'Français',
            'de': 'Deutsch'
        };

        let selectedLanguage = 'ja';

        // ドロップダウンの表示切り替え
        globeIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('show');
            updateDropdownSelection();
        });

        // 言語選択
        document.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const lang = item.dataset.lang;
                selectedLanguage = lang;
                currentLang.textContent = languageNames[lang];
                dropdown.classList.remove('show');
                vscode.postMessage({ type: 'changeLanguage', language: lang });
            });
        });

        // ドロップダウン外クリックで閉じる
        document.addEventListener('click', () => {
            dropdown.classList.remove('show');
        });

        function updateDropdownSelection() {
            document.querySelectorAll('.dropdown-item').forEach(item => {
                item.classList.toggle('selected', item.dataset.lang === selectedLanguage);
            });
        }

        // メッセージ受信
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'update':
                    content.innerHTML = message.content;
                    if (message.language) {
                        selectedLanguage = message.language;
                        currentLang.textContent = languageNames[message.language] || message.language;
                    }
                    break;
                case 'loading':
                    content.innerHTML = '<div class="loading"><div class="spinner"></div><span>' + message.message + '</span></div>';
                    break;
                case 'error':
                    content.innerHTML = '<div class="error">' + message.message + '</div>';
                    break;
                case 'scroll':
                    const targetElement = document.querySelector('[data-line="' + message.line + '"]');
                    if (targetElement) {
                        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                    break;
            }
        });

        // 準備完了を通知
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
