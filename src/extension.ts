import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import * as fs from 'fs';
import * as path from 'path';

/**
 * list of (string, tolerance%)
 */
const STOPS: [string, number][] = [
	['$(telescope)', 0],
	['see real world examples', 0],
	['github', 30],
	['gitlab', 30],
	['codeium: explain problem', 0],
	['codeium', 10],
	['tabnine', 10],
	['gpt', 10],
	['copilot', 10],
	['fix problem', 10],
	['fix', 70],
	['live', 70],
	['--', 30],
];

function checkStop(str: string, isHtml = false): boolean {
	let isStop = false;
	if (isHtml) {
		str = str.replace(/<[^>]*>/g, '');
	}
	str = str.toLowerCase().trim();
	if (str === '') return true;
	for (let j = 0; j < STOPS.length; j++) {
		const [stop, tole] = STOPS[j];
		const pos = str.indexOf(stop);
		if (pos !== -1) {
			if (tole === 0 || stop.length / str.length > tole / 100) {
				isStop = true;
				break;
			}
		}
	}
	return isStop;
}

export function activate(context: vscode.ExtensionContext) {
	// --- WebviewViewProvider ---
	const provider = new (class implements vscode.WebviewViewProvider {
		public webview: vscode.Webview | undefined;
		public themeClass: 'light' | 'dark' = 'light';
		public savedPinnedElements: any[] | null = null;
		public firstLoad = true;
		private mit: any;
		private shiki: any;

		constructor(
			private readonly extensionUri: vscode.Uri,
			private readonly context: vscode.ExtensionContext,
			public readonly viewId,
		) { }

		private async initShiki(themeClass: 'light' | 'dark') {
			this.mit = (await import('markdown-it')).default();
			this.shiki = (await import('@shikijs/markdown-it')).default;
			const shikimit = await this.shiki({
				theme: {
					light: 'light-plus',
					dark: 'dark-plus',
				}[themeClass],
			});
			await shikimit.apply(shikimit, [this.mit]);
			// ↑
			// Debugged from below
			//
			// this.mit.use(this.shiki.default({
			// 	themes: {
			// 		light: 'light-plus',
			// 		dark: 'dark-plus',
			// 	},
			// }))
		}

		public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): Thenable<void> | void {
			this.webview = webviewView.webview;
			const theme = vscode.window.activeColorTheme.kind;
			webviewView.webview.options = {
				enableScripts: true,
				localResourceRoots: [this.extensionUri],
			};
			this.setHtmlWithTheme(theme);
			webviewView.webview.onDidReceiveMessage(async (e) => {
				switch (e.type) {
					case 'ready':
						this.savedPinnedElements = this.savedPinnedElements ?? this.context.workspaceState.get('pinnedElements') ?? [];
						this.rerenderSavedPinnedElements().then(() => {
							webviewView.webview.postMessage({ type: 'loadPinned', elements: this.savedPinnedElements });
							setTimeout(() => {
								this.getDoc();
							}, this.firstLoad ? 5000 : 100);
						});
						break;
					case 'savePinned':
						this.context.workspaceState.update('pinnedElements', e.elements);
						this.savedPinnedElements = e.elements;
						break;
				}
			})
		}

		public async getDoc(editor: vscode.TextEditor | undefined = undefined) {
			if (!editor) editor = vscode.window.activeTextEditor;
			if (!editor) return;
			if (!this.webview) return;
			const selection = editor.selection;
			const position = editor.selection.active;

			// --- Get Markdown Texts ---
			let mdList: string[] = [];
			// ----- Get Hovers -----
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', editor.document.uri, position);
			if (hovers && hovers.length !== 0 && hovers[0].contents != null && hovers[0].contents.length > 0) {
				for (let i = 0; i < hovers.length; i++) {
					// @ts-ignore
					mdList.push(...hovers[i].contents.map((content) => content?.value ?? '---'));
				}
			}
			// ----- Get Diagnostics -----
			const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
			if (config('showDiagnostics') && diagnostics && diagnostics.length >= 0) {
				const relatedDiagnostics = diagnostics.filter(d => d.range.contains(position)).map(d => d.message);
				mdList.push(...relatedDiagnostics);
			}
			// ----- Get Signatures -----
			// const signatures = await vscode.commands.executeCommand<vscode.SignatureHelp[]>('vscode.executeSignatureHelpProvider', editor.document.uri, position);
			// console.log(signatures)
			// --- Render Markdown ---
			mdList = mdList.map(md => md.trim())
			if (mdList.length === 0) return;
			const [html, finalMdList] = await this.renderMarkdown(mdList);
			// --- Send to Webview ---
			this.webview.postMessage({ type: 'current', content: html, source: finalMdList });
			this.firstLoad = false;
		}

		public setHtmlWithTheme(theme: vscode.ColorThemeKind | string) {
			if (!this.webview) {
				console.error('no webview');
				return;
			}
			let themeClass: 'light' | 'dark' = 'light';
			if (typeof theme === 'string') {
				switch (theme) {
					case 'dark':
						themeClass = 'dark';
						break;
					case 'light':
					default:
						themeClass = 'light';
				}
			} else {
				switch (theme) {
					case vscode.ColorThemeKind.Dark:
					case vscode.ColorThemeKind.HighContrast:
						themeClass = 'dark';
						break;
					case vscode.ColorThemeKind.Light:
					case vscode.ColorThemeKind.HighContrastLight:
					default:
						themeClass = 'light';
				}
			}
			this.themeClass = themeClass;
			this.webview.html = webviewFill(
				this.extensionUri,
				this.webview,
				'index.html',
				{
					'theme': themeClass,
					'codeWrapping': config('codeWrapping') ? 'codeWrapping' : '',
				},
			)
			this.initShiki(themeClass);
		}

		public async renderMarkdown(mdList: string[]) {
			if (!this.mit) await this.initShiki(this.themeClass);
			let html: string = '';
			let source: string[] = [];
			for (let i = 0; i < mdList.length; i++) {
				while (html.endsWith('<hr>')) {
					html = html.slice(0, -4);
					html = html.trim();
				}
				if (checkStop(mdList[i])) continue;
				const newHtml = this.mit.render(mdList[i]);
				if (checkStop(newHtml, true)) continue;
				source.push(mdList[i]);
				html += newHtml;
				// python doc special case
				html = html.replace(/&lt;!--moduleHash:-{0,1}\d+--&gt;/g, '');
				// redundant lines
				html = html.replace(/<p>\s*<\/p>/g, '');
				html = html.trim();
				if (i < mdList.length - 1)
					html += '<hr>';
			}
			while (html.endsWith('<hr>')) {
				html = html.slice(0, -4);
				html = html.trim();
			}
			html = cleanLinefeedsOutsidePre(html);
			return [html, source];
		}

		public async rerenderSavedPinnedElements() {
			if (!this.webview) return;
			if (!this.savedPinnedElements) {
				this.savedPinnedElements = this.context.workspaceState.get('pinnedElements') ?? [];
			}
			for (let i = 0; i < this.savedPinnedElements.length; i++) {
				const ele = this.savedPinnedElements[i];
				ele.content = await this.renderMarkdown(ele.source);
			}
			this.context.workspaceState.update('pinnedElements', this.savedPinnedElements);
		}

	})(context.extensionUri, context, 'docpanel');

	const viewRegistration = vscode.window.registerWebviewViewProvider(
		provider.viewId,
		provider,
		{},
	)
	context.subscriptions.push(viewRegistration);

	// --- Listeners ---
	const configChangeListener = vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('docpanel.codeWrapping')) {
			updateAvailability();
			provider.setHtmlWithTheme(provider.themeClass);
		}
	});
	const fileChangeListener = vscode.workspace.onDidChangeTextDocument(() => {
		updateAvailability();
		provider.getDoc();
	})
	const fileChangeListener2 = vscode.workspace.onDidChangeNotebookDocument(() => {
		updateAvailability();
		provider.getDoc();
	})
	const folderChangeListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		updateAvailability();
		provider.getDoc();
	})
	context.subscriptions.push(configChangeListener, fileChangeListener, fileChangeListener2, folderChangeListener);

	const docListener = vscode.window.onDidChangeTextEditorSelection(async (e) => {
		const editor = e.textEditor ?? undefined;
		if (!provider) return;
		updateAvailability();
		await provider.getDoc(editor);
	})
	context.subscriptions.push(docListener);

	const themeListener = vscode.window.onDidChangeActiveColorTheme((event) => {
		provider.setHtmlWithTheme(event.kind);
	});
	context.subscriptions.push(themeListener);

	// --- Commands ---
	let refreshCmd = vscode.commands.registerCommand('docpanel.refresh-active-doc', () => {
		updateAvailability();
		provider.setHtmlWithTheme(provider.themeClass);
		provider.getDoc();
	});
	context.subscriptions.push(refreshCmd);


	// --- Init ---
	updateAvailability();
}

export function deactivate() { }

function webviewFill(
	extensionUri: vscode.Uri,
	webview: vscode.Webview,
	htmlFile: string,
	dict: { [key: string]: string },
): string {
	const htmlPath = path.join(extensionUri.fsPath, 'dist', 'web', htmlFile);
	let html = fs.readFileSync(htmlPath, 'utf8');

	html = html.replace(/{{([^:]*?)}}/g, (_, key) => {
		const value = dict[key];
		return value ? value : '';
	});

	html = html.replace(/{{file:(.*?)}}/g, (_, file) => {
		const filePath = vscode.Uri.joinPath(extensionUri, 'dist', 'web', file);
		return webview.asWebviewUri(filePath).toString();
	});

	html = cleanLinefeedsOutsidePre(html);
	return html;
}

function cleanLinefeedsOutsidePre(html: string): string {
	// A stack to track open <pre> tags
	const preStack: number[] = [];
	const result: string[] = [];

	// Match HTML tags and text between them
	const regex = /<[^>]+>|[^<]+/g;
	let match;

	while ((match = regex.exec(html)) !== null) {
		const fragment = match[0];

		if (fragment.startsWith("<")) {
			// Check if it's an opening or closing <pre> tag
			if (/^<pre(\s|>|$)/i.test(fragment)) {
				preStack.push(result.length);
			} else if (/^<\/pre>/i.test(fragment)) {
				preStack.pop();
			}
			// Add the tag as-is
			result.push(fragment);
		} else {
			// Text content outside <pre> tags
			if (preStack.length === 0) {
				// Remove newlines from the text
				result.push(fragment.replace(/\n/g, ""));
			} else {
				// Keep text inside <pre> tags as-is
				result.push(fragment);
			}
		}
	}

	return result.join("");
}

function config<T>(key: string, value: any = null) {
	if (value == null) {
		return vscode.workspace.getConfiguration('docpanel').get<T>(key);
	} else {
		return vscode.workspace.getConfiguration('docpanel').update(key, value, vscode.ConfigurationTarget.Workspace);
	}
}

function updateAvailability() {
	// --- Languages ---
	const currentFileLang = vscode.window.activeTextEditor?.document.languageId ?? '';

	// --- Availability ---
	const available = true

	// --- Set Context Key ---
	vscode.commands.executeCommand('setContext', 'docpanel.showView', available);
}