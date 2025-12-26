import * as vscode from 'vscode';

export class TranslateService {
    private _cache: Map<string, string> = new Map();

    private readonly _languageNames: { [key: string]: string } = {
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

    public async translate(content: string, targetLanguage: string): Promise<string> {
        const cacheKey = `${targetLanguage}:${content}`;

        // Check cache
        if (this._cache.has(cacheKey)) {
            return this._cache.get(cacheKey)!;
        }

        const translatedContent = await this._callLanguageModelApi(content, targetLanguage);
        const htmlContent = this._convertMarkdownToHtml(translatedContent);
        this._cache.set(cacheKey, htmlContent);
        return htmlContent;
    }

    private async _callLanguageModelApi(content: string, targetLanguage: string): Promise<string> {
        const targetLangName = this._languageNames[targetLanguage] || targetLanguage;

        // Select available chat model
        const models = await vscode.lm.selectChatModels();
        if (models.length === 0) {
            throw new Error('No language model available. Please install GitHub Copilot or another language model extension.');
        }

        const model = models[0];
        const prompt = `Translate the following Markdown content to ${targetLangName}. Keep the Markdown formatting intact. Only translate the text content, not the Markdown syntax or code blocks. Output only the translated content without any explanation.

${content}`;

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];

        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

        // Collect response chunks
        let result = '';
        for await (const chunk of response.text) {
            result += chunk;
        }

        return result || content;
    }

    private _convertMarkdownToHtml(markdown: string): string {
        const lines = markdown.split('\n');
        let html = '';
        let inCodeBlock = false;
        let codeBlockContent = '';
        let codeBlockLang = '';
        let lineNumber = 0;
        let inList = false;
        let listType = '';

        for (const line of lines) {
            // Handle code blocks
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

            // Handle empty lines
            if (line.trim() === '') {
                if (inList) {
                    html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                    inList = false;
                }
                lineNumber++;
                continue;
            }

            // Handle headings
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

            // Handle lists
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

            // Handle blockquotes
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

            // Handle horizontal rules
            if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
                if (inList) {
                    html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                    inList = false;
                }
                html += `<hr data-line="${lineNumber}">\n`;
                lineNumber++;
                continue;
            }

            // Normal paragraph
            if (inList) {
                html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
                inList = false;
            }
            html += `<p data-line="${lineNumber}">${this._processInlineElements(line)}</p>\n`;
            lineNumber++;
        }

        // Close unclosed list
        if (inList) {
            html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
        }

        return html;
    }

    private _processInlineElements(text: string): string {
        // HTML escape
        text = this._escapeHtml(text);

        // Bold **text** or __text__
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');

        // Italic *text* or _text_
        text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
        text = text.replace(/_(.+?)_/g, '<em>$1</em>');

        // Inline code `code`
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Link [text](url)
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

        // Strikethrough ~~text~~
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
