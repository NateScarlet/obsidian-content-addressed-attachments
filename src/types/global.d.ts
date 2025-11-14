interface Window {
	electron?: {
		shell?: {
			openPath(path: string): void;
			openExternal(url: string): void;
		};
	};
}
