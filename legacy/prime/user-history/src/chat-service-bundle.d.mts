export declare const BUNDLE: string;
export declare function anchorImportMeta(source: string, file: string, outDir?: string): string;
export declare function bundleChatService(input?: { entry?: string; outfile?: string }): Promise<string>;
export declare const GUARD_BUNDLE: string;
export declare function bundleChatGuard(input?: { entry?: string; outfile?: string }): Promise<string>;
