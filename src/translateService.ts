import * as vscode from 'vscode';

export class TranslateService {
    private _cache: Map<string, string> = new Map();

    public async translate(content: string, targetLanguage: string): Promise<string> {
        const cacheKey = `${targetLanguage}:${content}`;

        // キャッシュチェック
        if (this._cache.has(cacheKey)) {
            return this._cache.get(cacheKey)!;
        }

        const apiKey = vscode.workspace.getConfiguration('translateView').get<string>('apiKey');

        if (!apiKey) {
            // APIキーがない場合はMarkdownをHTMLに変換して返す（デモモード）
            return this._convertMarkdownToHtml(content, targetLanguage);
        }

        try {
            const translatedContent = await this._callTranslateApi(content, targetLanguage, apiKey);
            const htmlContent = this._convertMarkdownToHtml(translatedContent, targetLanguage);
            this._cache.set(cacheKey, htmlContent);
            return htmlContent;
        } catch (error) {
            throw error;
        }
    }

    private async _callTranslateApi(content: string, targetLanguage: string, apiKey: string): Promise<string> {
        const languageNames: { [key: string]: string } = {
            'ja': 'Japanese',
            'en': 'English',
            'zh': 'Chinese',
            'ko': 'Korean',
            'es': 'Spanish',
            'fr': 'French',
            'de': 'German'
        };

        const targetLangName = languageNames[targetLanguage] || targetLanguage;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-5-mini',
                messages: [
                    {
                        role: 'system',
                        content: `You are a translator. Translate the following Markdown content to ${targetLangName}. Keep the Markdown formatting intact. Only translate the text content, not the Markdown syntax or code blocks.`
                    },
                    {
                        role: 'user',
                        content: content
                    }
                ],
                temperature: 0.3
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`API Error: ${response.status} - ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0]?.message?.content || content;
    }

    private _convertMarkdownToHtml(markdown: string, targetLanguage: string): string {
        const lines = markdown.split('\n');
        let html = '';
        let inCodeBlock = false;
        let codeBlockContent = '';
        let codeBlockLang = '';
        let lineNumber = 0;
        let inList = false;
        let listType = '';

        for (const line of lines) {
            // コードブロックの処理
            if (line.startsWith('```')) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeBlockLang = line.slice(3).trim();
                    codeBlockContent = '';
                } else {
                    html += `<pre data-line="${lineNumber}"><code class="language-${codeBlockLang}">${this._escapeHtml(codeBlockContent)}</code></pre>\n`;
                    inCodeBlock = false;
                }
                lineNumber++;
                continue;
            }

            if (inCodeBlock) {
                codeBlockContent += line + '\n';
                lineNumber++;
                continue;
            }

            // 空行の処理
            if (line.trim() === '') {
                if (inList) {
                    html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                    inList = false;
                }
                lineNumber++;
                continue;
            }

            // 見出しの処理
            const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                if (inList) {
                    html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                    inList = false;
                }
                const level = headingMatch[1].length;
                const text = this._processInlineElements(headingMatch[2]);
                html += `<h${level} data-line="${lineNumber}">${text}</h${level}>\n`;
                lineNumber++;
                continue;
            }

            // リストの処理
            const ulMatch = line.match(/^[\-\*]\s+(.+)$/);
            const olMatch = line.match(/^\d+\.\s+(.+)$/);

            if (ulMatch) {
                if (!inList || listType !== 'ul') {
                    if (inList) {
                        html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                    }
                    html += '<ul>\n';
                    inList = true;
                    listType = 'ul';
                }
                html += `<li data-line="${lineNumber}">${this._processInlineElements(ulMatch[1])}</li>\n`;
                lineNumber++;
                continue;
            }

            if (olMatch) {
                if (!inList || listType !== 'ol') {
                    if (inList) {
                        html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                    }
                    html += '<ol>\n';
                    inList = true;
                    listType = 'ol';
                }
                html += `<li data-line="${lineNumber}">${this._processInlineElements(olMatch[1])}</li>\n`;
                lineNumber++;
                continue;
            }

            // 引用の処理
            const blockquoteMatch = line.match(/^>\s*(.*)$/);
            if (blockquoteMatch) {
                if (inList) {
                    html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                    inList = false;
                }
                html += `<blockquote data-line="${lineNumber}">${this._processInlineElements(blockquoteMatch[1])}</blockquote>\n`;
                lineNumber++;
                continue;
            }

            // 水平線の処理
            if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
                if (inList) {
                    html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                    inList = false;
                }
                html += `<hr data-line="${lineNumber}">\n`;
                lineNumber++;
                continue;
            }

            // 通常の段落
            if (inList) {
                html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                inList = false;
            }
            html += `<p data-line="${lineNumber}">${this._processInlineElements(line)}</p>\n`;
            lineNumber++;
        }

        // リストが閉じられていない場合
        if (inList) {
            html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
        }

        return html;
    }

    private _processInlineElements(text: string): string {
        // HTMLエスケープ
        text = this._escapeHtml(text);

        // 太字 **text** または __text__
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');

        // 斜体 *text* または _text_
        text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
        text = text.replace(/_(.+?)_/g, '<em>$1</em>');

        // インラインコード `code`
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

        // リンク [text](url)
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

        // 取り消し線 ~~text~~
        text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

        return text;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
