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

        if (this._cache.has(cacheKey)) {
            return this._cache.get(cacheKey)!;
        }

        const translatedContent = await this._callLanguageModelApi(content, targetLanguage);
        this._cache.set(cacheKey, translatedContent);
        return translatedContent;
    }

    private async _callLanguageModelApi(content: string, targetLanguage: string): Promise<string> {
        const targetLangName = this._languageNames[targetLanguage] || targetLanguage;

        const models = await vscode.lm.selectChatModels();
        if (models.length === 0) {
            throw new Error('No language model available. Please install GitHub Copilot or another language model extension.');
        }

        const model = models[0];
        const prompt = `Translate the following Markdown content to ${targetLangName}. Keep the Markdown formatting intact. Only translate the text content, not the Markdown syntax or code blocks. Output only the translated content without any explanation.

${content}`;

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];

        const cancellationTokenSource = new vscode.CancellationTokenSource();
        try {
            const response = await model.sendRequest(messages, {}, cancellationTokenSource.token);

            let result = '';
            for await (const chunk of response.text) {
                result += chunk;
            }

            return result || content;
        } finally {
            cancellationTokenSource.dispose();
        }
    }
}
