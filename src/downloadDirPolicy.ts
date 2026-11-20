/**
 * 下载目录口径：本 module 拥有「哪些目录参与哪种口径」的全部判据。
 *
 * 完整列表用于读取白名单、恢复目标与文件管理器「下载」标签页；配额集合用于写入前的
 * 自动清理；落盘选择用于各条下载路径。禁用过滤、仅读取过滤、去重与回退规则集中于此，
 * 口径判据与消费方之间只有命名查询这一层接缝（ADR-0009 / ADR-0010）。
 */

/** 用户在设置中配置的 URL 模板化远程服务 */
export interface GatewayConfig {
	urlTemplate: string;
	name: string;
	headers: [key: string, value: string][];
	enabled: boolean;
	downloadDir?: string;
}

/** 完整目录查询所需的最小设置投影，避免与设置模块形成循环依赖 */
export interface DownloadDirSettings {
	downloadDir: string;
	gateways: readonly Pick<GatewayConfig, "enabled" | "downloadDir">[];
}

/** 配额口径所需的最小网关投影 */
export type QuotaGateway = Pick<
	GatewayConfig,
	"enabled" | "downloadDir" | "urlTemplate"
>;

// #region 内部判据

/** 目录集合去重、忽略空值 */
function dedupDirs(...dirs: string[]): string[] {
	return [...new Set(dirs)].filter(Boolean);
}

/**
 * 启用网关声明的下载目录。
 *
 * 禁用网关等价于不存在：它不作为来源，因而不声明副本位置——其目录不进入任何下载
 * 目录口径。判据按目录集合：同一目录若还被任一启用的配置声明，照常参与。
 */
function enabledGatewayDownloadDirs(
	gateways: readonly Pick<GatewayConfig, "enabled" | "downloadDir">[],
): string[] {
	return gateways.filter((g) => g.enabled).map((g) => g.downloadDir ?? "");
}

// #endregion

// #region 对外查询

/**
 * 该网关是否会产生远程来源：URL 模板为空时渲染不出任何 URL，它退化为「仅从下载
 * 目录读取已有文件」，既不产生来源也不会让插件往它声明的目录落盘。
 * 下载配额据此排除这类目录。
 */
export function gatewayProducesSource(config: {
	urlTemplate: string;
}): boolean {
	return !!config.urlTemplate;
}

/**
 * 完整下载目录列表：全局下载目录与各启用网关专属下载目录（去重、忽略空值）。
 * 仅用于读取的网关目录也在其中——排除只作用于配额口径。
 */
export function allDownloadDirs(settings: DownloadDirSettings): string[] {
	return dedupDirs(
		settings.downloadDir,
		...enabledGatewayDownloadDirs(settings.gateways),
	);
}

/**
 * 参与配额的下载目录：只计全局下载目录与「会产生远程来源」的启用网关专属目录。
 *
 * URL 模板为空的网关目录可能由外部应用管理，自动清理直接按 CAS 命名约定删磁盘文件、
 * 不查元数据，把这些目录计入会替外部应用删文件。判据按目录集合而非配置来源：同一
 * 目录只要还被任一启用且会产生来源的配置声明，就仍参与配额。
 */
export function quotaDownloadDirs(
	downloadDir: string,
	gateways: readonly QuotaGateway[],
): string[] {
	return dedupDirs(
		downloadDir,
		...enabledGatewayDownloadDirs(gateways.filter(gatewayProducesSource)),
	);
}

/**
 * 落盘目录选择：网关目录 → 全局下载目录 → 主存储目录。
 * 无网关配置时（普通 HTTP、额外来源、锁定链接恢复）退化为后两者。
 * 空字符串视为未配置，与缺省等价。
 */
export function selectLandingDir(
	gateway: Pick<GatewayConfig, "downloadDir"> | undefined,
	downloadDir: string,
	primaryDir: string,
): string {
	return gateway?.downloadDir || downloadDir || primaryDir;
}

// #endregion
