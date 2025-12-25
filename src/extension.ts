import * as vscode from 'vscode';
import { TranslateViewProvider } from './translateViewProvider';

let translateViewProvider: TranslateViewProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('Translate View extension is now active!');

    // Register WebView provider
    translateViewProvider = new TranslateViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            TranslateViewProvider.viewType,
            translateViewProvider
        )
    );

    // Register command
    context.subscriptions.push(
        vscode.commands.registerCommand('translateView.open', () => {
            vscode.commands.executeCommand('translateView.webview.focus');
        })
    );

    // Watch for active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === 'markdown') {
                translateViewProvider.updateContent(editor.document);
            }
        })
    );

    // Watch for document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor &&
                event.document === activeEditor.document &&
                event.document.languageId === 'markdown') {
                translateViewProvider.updateContent(event.document);
            }
        })
    );

    // Watch for editor scroll
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (event.textEditor.document.languageId === 'markdown' &&
                event.visibleRanges.length > 0) {
                const firstVisibleLine = event.visibleRanges[0].start.line;
                translateViewProvider.syncScroll(firstVisibleLine);
            }
        })
    );

    // Initial display
    if (vscode.window.activeTextEditor?.document.languageId === 'markdown') {
        translateViewProvider.updateContent(vscode.window.activeTextEditor.document);
    }
}

export function deactivate() {}
