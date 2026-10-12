import type { App } from "obsidian";
import type EncryptionService from "../lib/encryption/EncryptionService";
import type EncryptPathPolicy from "../lib/encryption/EncryptPathPolicy";
import type ReferenceManager from "../ReferenceManager";
import type { URLResolver } from "../URLResolver";
import type { CAS } from "./CAS";

/**
 * 多条命令路径共用的插件依赖。
 * encryptPathPolicy 可选是因为加密路径允许在无路径策略时退化为仅使用主密钥；
 * 需要该依赖的路径在各自的上下文类型里重新收窄为必需。
 */
export default interface PluginContext {
	app: App;
	cas: CAS;
	encryptionService: EncryptionService;
	urlResolver: URLResolver;
	referenceManager: ReferenceManager;
	encryptPathPolicy?: EncryptPathPolicy;
}

/** PluginContext 的组装来源：插件实例持有同一组依赖且全部就绪 */
export type PluginContextSource = Required<PluginContext>;
