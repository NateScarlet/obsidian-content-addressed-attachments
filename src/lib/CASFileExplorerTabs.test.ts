// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/svelte";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import CASFileExplorerTabs from "./CASFileExplorerTabs.svelte";
import CASFileExplorerContextProvider from "../../test/CASFileExplorerContextProvider.svelte";
import { Mode, type CASFileExplorerContext } from "./CASFileExplorerContext";
import { casMetadataSave } from "#src/events";
import type { CASMetadata } from "#src/types/CASMetadata";

type StorageEstimate = {
	normalBytes: number;
	trashBytes: number;
	dirBytes: Record<string, number>;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const FIRST_ESTIMATE: StorageEstimate = {
	normalBytes: 1024,
	trashBytes: 2048,
	dirBytes: { enabled: 512, disabled: 4096 },
};

/** 三个标签共用的标签名（顺序即渲染顺序） */
const SIZE_TABS = ["Local", "Recycle bin", "Downloads"] as const;

/**
 * 受控的 estimateStorage：每次调用都挂起，由测试决定何时返回，
 * 这样「刷新进行中」的时间窗口才是确定的。
 */
function renderTabs() {
	const pending: Array<ReturnType<typeof deferred<StorageEstimate>>> = [];
	const casMetadata = {
		estimateStorage: () => {
			const d = deferred<StorageEstimate>();
			pending.push(d);
			return d.promise;
		},
	} as unknown as CASMetadata;
	const context = {
		casMetadata,
		mode: { value: Mode.LOCAL },
		getDownloadDirs: () => ["enabled"],
	} as unknown as CASFileExplorerContext;

	render(CASFileExplorerContextProvider, {
		props: { value: context, component: CASFileExplorerTabs },
	});
	return { pending };
}

/** 标签页元素 */
function tab(label: string) {
	return screen
		.getAllByRole("tab")
		.find((el) => el.textContent?.startsWith(label));
}

/** 标签页的可见文本（去掉模板换行带来的首尾空白） */
function tabText(label: string) {
	return tab(label)?.textContent?.trim();
}

/** 承载占用数字的 span（标签文字不在 span 内） */
function sizeSpan(label: string) {
	return tab(label)?.querySelector("span");
}

/** 一次保存事件触发的重算是否已发出（组件内有 100ms 去抖窗口） */
async function awaitRefresh(pending: unknown[]) {
	await vi.waitFor(() => expect(pending).toHaveLength(2));
	await act();
}

async function aSavedObject() {
	const digest = await sha256.digest(new TextEncoder().encode("payload"));
	return { cid: CID.create(1, 0x55, digest), indexedAt: new Date(0) };
}

afterEach(() => {
	cleanup();
});

describe("CASFileExplorerTabs 占用数字的刷新表现", () => {
	it("首次统计尚未返回时保持空白，不显示占位数字", async () => {
		const { pending } = renderTabs();
		await act();

		expect(tabText("Local")).toBe("Local");
		expect(pending).toHaveLength(1);
	});

	it("统计返回后按本地/回收站/已启用下载目录显示占用", async () => {
		const { pending } = renderTabs();
		await act();
		pending[0].resolve(FIRST_ESTIMATE);
		await act();

		expect(tabText("Local")).toBe("Local 1.0 KiB");
		expect(tabText("Recycle bin")).toBe("Recycle bin 2.0 KiB");
		expect(tabText("Downloads")).toBe("Downloads 512 B");
	});

	it("刷新期间保留上一次的数字并脉冲，不再闪退为空白", async () => {
		const { pending } = renderTabs();
		await act();
		pending[0].resolve(FIRST_ESTIMATE);
		await act();
		const before = SIZE_TABS.map((label) => tabText(label));

		casMetadataSave.dispatch({ detail: await aSavedObject() });
		await awaitRefresh(pending);

		// 旧值仍在，只是被标记为过时；三个数字共享这一次统计，脉冲同步
		expect(pending).toHaveLength(2);
		SIZE_TABS.forEach((label, i) => {
			expect(tabText(label)).toBe(before[i]);
			expect(sizeSpan(label)?.className).toContain("animate-pulse");
		});

		pending[1].resolve({ ...FIRST_ESTIMATE, normalBytes: 3072 });
		await act();

		expect(tabText("Local")).toBe("Local 3.0 KiB");
		for (const label of SIZE_TABS) {
			expect(sizeSpan(label)?.className).not.toContain("animate-pulse");
		}
	});
});
