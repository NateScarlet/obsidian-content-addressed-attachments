import type PluginContext from "./types/PluginContext";
import type { PluginContextSource } from "./types/PluginContext";

/**
 * 从插件实例取出各命令共享的依赖，避免各调用点重复罗列字段。
 */
export default function createPluginContext(
	plugin: PluginContextSource,
): PluginContext {
	return {
		app: plugin.app,
		cas: plugin.cas,
		encryptionService: plugin.encryptionService,
		urlResolver: plugin.urlResolver,
		referenceManager: plugin.referenceManager,
		encryptPathPolicy: plugin.encryptPathPolicy,
	};
}
