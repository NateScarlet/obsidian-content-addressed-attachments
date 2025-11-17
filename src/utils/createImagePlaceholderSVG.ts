import { mdiProgressDownload, mdiInformation, mdiAlert } from "@mdi/js";
import escapeXML from "./escapeXML";

// 类型定义接口

interface TypeDefinition {
	light: {
		background: string;
		icon: string;
	};
	dark: {
		background: string;
		icon: string;
	};
	iconPath: string;
}

type PlaceholderType = "loading" | "error" | "info";

// 类型定义存储

const typeDefinitions = new Map<PlaceholderType, TypeDefinition>();

// 定义类型的函数
function defineType(type: PlaceholderType, definition: TypeDefinition) {
	typeDefinitions.set(type, definition);
	return definition;
}

export default function createImagePlaceholderSVG(
	message: string,
	type: PlaceholderType = "info",
): string {
	// 配置参数
	const config = {
		width: 300,
		height: 200,
		borderRadius: 8,
		fontFamily:
			"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
		fontSize: 24,
		iconSize: 48,
		spacing: 16,
	};

	// 获取类型定义，默认为 info 类型
	const typeDef = typeDefinitions.get(type) ?? infoDef;

	// 计算居中位置
	const iconX = config.width / 2;
	const iconY = config.height / 2 - config.spacing;
	const textX = config.width / 2;
	const textY = config.height / 2 + config.iconSize / 2 + config.spacing;

	// 构建SVG
	return `
<svg width="100%" height="100%" viewBox="0 0 ${config.width} ${config.height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    <![CDATA[
      /* 浅色模式默认样式 */
      .background {
        fill: ${typeDef.light.background};
      }
      .icon {
        fill: ${typeDef.light.icon};
      }
      .text {
        fill: #374151;
      }
      .loading-circle-bg {
        stroke: ${typeDef.light.icon};
      }
      .loading-circle-spinner {
        stroke: ${typeDef.light.icon};
      }
      
      /* 暗黑模式媒体查询 */
      @media (prefers-color-scheme: dark) {
        .background {
          fill: ${typeDef.dark.background};
        }
        .icon {
          fill: ${typeDef.dark.icon};
        }
        .text {
          fill: #d1d5db;
        }
        .loading-circle-bg {
          stroke: ${typeDef.dark.icon};
        }
        .loading-circle-spinner {
          stroke: ${typeDef.dark.icon};
        }
      }

    ]]>
  </style>
  
  <!-- 背景 -->
  <rect width="100%" height="100%" rx="${config.borderRadius}" class="background"/>
  
  <!-- 图标 -->
  <g transform="translate(${iconX - config.iconSize / 2} ${iconY - config.iconSize / 2})">
    <path d="${typeDef.iconPath}" class="icon" transform="scale(${config.iconSize / 24})"/>
  </g>
  
  <!-- 加载动画（仅loading类型） -->
  ${
		type === "loading"
			? `
    <circle cx="${iconX}" cy="${iconY}" r="${config.iconSize / 2 + 4}" fill="none" stroke-opacity="0.3" class="loading-circle-bg"/>
    <circle cx="${iconX}" cy="${iconY}" r="${config.iconSize / 2 + 4}" fill="none" stroke-dasharray="20 10" stroke-linecap="round" class="loading-circle-spinner">
      <animateTransform attributeName="transform" type="rotate" from="0 ${iconX} ${iconY}" to="360 ${iconX} ${iconY}" dur="1.5s" repeatCount="indefinite"/>
    </circle>
  `
			: ""
  }
  
  <!-- 文字 -->
  <text x="${textX}" y="${textY}" text-anchor="middle" class="text" font-family="${config.fontFamily}" font-size="${config.fontSize}" font-weight="500">
    ${escapeXML(message)}
  </text>
</svg>`.trim();
}

//#region 类型定义
defineType("loading", {
	light: {
		background: "#f8f9fa",
		icon: "#3b82f6",
	},
	dark: {
		background: "#1a1a1a",
		icon: "#60a5fa",
	},
	iconPath: mdiProgressDownload,
});

defineType("error", {
	light: {
		background: "#fef2f2",
		icon: "#ef4444",
	},
	dark: {
		background: "#2a0f0f",
		icon: "#f87171",
	},
	iconPath: mdiAlert,
});

const infoDef = defineType("info", {
	light: {
		background: "#f0f9ff",
		icon: "#10b981",
	},
	dark: {
		background: "#0a1f2e",
		icon: "#34d399",
	},
	iconPath: mdiInformation,
});

//#endregion
