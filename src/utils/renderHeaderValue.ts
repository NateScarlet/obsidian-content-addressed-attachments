import mustache from "mustache";

/**
 * 从 Obsidian SecretStorage 读取 secret 的能力，由最外层注入。
 * 这里的 secret 是用户在原生钥匙串里维护的通用凭据，与插件的加密密钥是两个概念。
 */
export type SecretReader = (
	id: string,
) => string | undefined | null | Promise<string | undefined | null>;

// 原生钥匙串的 ID 只允许小写字母、数字与破折号，不含点号
const SECRET_PLACEHOLDER = /\{\{\s*secrets\.([a-z0-9-]+)\s*\}\}/g;

/**
 * 渲染单个 header 值中的 `{{secrets.<id>}}` 占位符。
 *
 * 先扫出所有待替换的 ID 并解析出值，再逐个占位符交给 Mustache 渲染：模板里只含当前
 * 这一个 secrets 标签，值里的其它文本和其它 Mustache 标签因此不会被解析或清空。
 * escape 原样返回，secret 中的 `&`、`/`、`=`、`+` 等字符不会被 HTML 转义或 URL 编码。
 * 不存在、读取报错或 SecretStorage 不可用时保留原占位符且不抛错；每次调用都实时读取。
 */
export default async function renderHeaderValue(
	value: string,
	readSecret: SecretReader,
): Promise<string> {
	const ids = new Set(
		Array.from(value.matchAll(SECRET_PLACEHOLDER), (match) => match[1]),
	);
	if (ids.size === 0) return value;

	const resolved = new Map<string, string>();
	await Promise.all(
		[...ids].map(async (id) => {
			let secret: string | undefined | null;
			try {
				secret = await readSecret(id);
			} catch {
				// 读取失败视为不可用：保留占位符，不阻断请求
				return;
			}
			if (typeof secret === "string") resolved.set(id, secret);
		}),
	);

	return value.replace(SECRET_PLACEHOLDER, (placeholder, id: string) => {
		const secret = resolved.get(id);
		if (secret === undefined) return placeholder;
		return mustache.render(
			`{{secrets.${id}}}`,
			{ secrets: { [id]: () => secret } },
			undefined,
			{ escape: (text) => String(text) },
		);
	});
}
