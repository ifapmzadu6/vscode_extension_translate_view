import * as vscode from 'vscode';

export class TranslateService {
    private _cache: Map<string, string> = new Map();

    public async translate(content: string, targetLanguage: string): Promise<string> {
        const cacheKey = `${targetLanguage}:${content}`;

        // Check cache
        if (this._cache.has(cacheKey)) {
            return this._cache.get(cacheKey)!;
        }

        const apiKey = vscode.workspace.getConfiguration('translateView').get<string>('apiKey');

        if (!apiKey) {
            // If no API key, convert Markdown to HTML (demo mode)
            return this._convertMarkdownToHtml(content);
        }

        const translatedContent = await this._callTranslateApi(content, targetLanguage, apiKey);
        const htmlContent = this._convertMarkdownToHtml(translatedContent);
        this._cache.set(cacheKey, htmlContent);
        return htmlContent;
    }

    private async _callTranslateApi(content: string, targetLanguage: string, apiKey: string): Promise<string> {
        const languageNames: { [key: string]: string } = {
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
