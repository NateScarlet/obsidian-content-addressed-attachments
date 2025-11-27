export default function isEventTargetScrollToEnd(e: Event): boolean {
	if (!(e.target instanceof HTMLElement)) {
		return false;
	}
	const el = e.target;
	if (
		el.scrollHeight > el.clientHeight &&
		// page zoom may cause inexact match
		el.scrollTop + el.clientHeight + 2 > el.scrollHeight
	) {
		return true;
	}
	if (
		el.scrollWidth > el.clientWidth &&
		// page zoom may cause inexact match
		el.scrollLeft + el.clientWidth + 2 > el.scrollWidth
	) {
		return true;
	}

	return false;
}
