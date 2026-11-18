/**
 * Keyboard check for the command palette, in the real served app. Focus stays in the search box throughout; the
 * arrows move a selection through the results. The selected row must always be wholly inside the results pane (not
 * merely inside the window: the pane scrolls and clips), reachable there, and named to assistive technology by the
 * search box. Enter must run the row that is selected and on screen. Every check that does not hold fails the audit.
 */
export type PaletteCheck = { name: string; ok: boolean; detail: unknown };

const OPEN = "dialog[data-command-palette][open]";

/** The palette's selection, measured against the pane that scrolls it. Null when the palette is not open. */
const PALETTE = () => {
  const dialog = document.querySelector<HTMLDialogElement>("dialog[data-command-palette]");
  if (!dialog?.open) return null;
  const input = dialog.querySelector<HTMLInputElement>("[data-command-palette-input]")!;
  const pane = dialog.querySelector<HTMLElement>("[data-command-palette-list]")!;
  const rows = [...pane.querySelectorAll<HTMLElement>("[data-command-palette-item]")];
  const selected = rows.filter(row => row.getAttribute("aria-selected") === "true");
  const row = selected[0] ?? null;
  const p = pane.getBoundingClientRect(), r = row?.getBoundingClientRect();
  return {
    rows: rows.length, selectedCount: selected.length,
    index: row ? rows.indexOf(row) : -1,
    item: row?.dataset.commandPaletteItem ?? null,
    focusInSearch: document.activeElement === input,
    // What the search box tells assistive technology: it is a combobox over this list, and this is the active option.
    named: !!row && !!row.id && input.getAttribute("aria-activedescendant") === row.id && input.getAttribute("role") === "combobox"
      && input.getAttribute("aria-controls") === pane.id && pane.getAttribute("role") === "listbox" && row.getAttribute("role") === "option",
    inPane: !!r && r.top >= p.top - 0.5 && r.bottom <= p.bottom + 0.5,
    reached: !!r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-command-palette-item]") === row,
    headings: [...pane.querySelectorAll(".cp-group__title")].map(heading => heading.textContent),
    scrolls: pane.scrollHeight > pane.clientHeight + 1, scrollTop: pane.scrollTop,
    row: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null, pane: { top: Math.round(p.top), bottom: Math.round(p.bottom) },
  };
};
type Palette = NonNullable<ReturnType<typeof PALETTE>>;
/** The selection is one row, shown whole in the pane, reachable, and named by the search box, which keeps focus. */
const shown = (p: Palette | null): boolean => !!p && p.selectedCount === 1 && p.inPane && p.reached && p.named && p.focusInSearch;

/** `open()` returns a page on a signed-in chat screen. */
export async function runPaletteChecks(
  open: () => Promise<any>,
  shot: (page: any, label: string) => Promise<void>,
): Promise<{ checks: PaletteCheck[]; error: string | null }> {
  const checks: PaletteCheck[] = [];
  const check = (name: string, ok: boolean, detail: unknown) => { checks.push({ name, ok, detail }); };
  try {
    const page = await open();
    const read = async (): Promise<Palette | null> => { await page.waitForTimeout(150); return page.evaluate(PALETTE); };
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForSelector(`${OPEN} [data-command-palette-group="start"] [data-command-palette-item]`, { state: "visible", timeout: 10_000 });
    const start = await read();
    check("the palette opens on a short list with its first row selected, shown and named", shown(start) && start!.index === 0 && start!.rows <= 10 && start!.scrollTop === 0
      && start!.headings.join("|") === "Jump to|Actions", start);
    // Up from the first row wraps to the last, which starts below the pane: it must be brought into it.
    await page.keyboard.press("ArrowUp");
    const wrapped = await read();
    check("Arrow Up from the first row selects the last, shown whole inside the results pane", shown(wrapped) && wrapped!.index === wrapped!.rows - 1, wrapped);
    await shot(page, "palette-wrapped");
    // Down from the last row wraps to the first, with its heading back in view.
    await page.keyboard.press("ArrowDown");
    const first = await read();
    check("Arrow Down from the last row selects the first, at the top of the pane", shown(first) && first!.index === 0 && first!.scrollTop === 0, first);
    // A long typed list: every step of the selection stays inside the pane, both ways round.
    await page.keyboard.type("a");
    await page.waitForSelector(`${OPEN} [data-command-palette-group="teammate"] [data-command-palette-item]`, { state: "visible", timeout: 10_000 });
    const typed = await read();
    check("typing keeps focus in search and each kind under one heading", shown(typed) && typed!.index === 0 && new Set(typed!.headings).size === typed!.headings.length, typed);
    const outside: unknown[] = [];
    let steps = 0, scrolled = false;
    for (let step = 0; step < Math.min(typed?.rows ?? 0, 40); step++) {
      await page.keyboard.press("ArrowDown");
      const at = await page.evaluate(PALETTE);
      steps++;
      if (at?.scrollTop) scrolled = true;
      if (!shown(at) || at!.index !== (step + 1) % at!.rows) outside.push({ step, at });
    }
    check("Arrow Down through a long typed list keeps every selected row inside the pane", !!typed && steps > 0 && outside.length === 0 && (!typed.scrolls || scrolled), { rows: typed?.rows, steps, scrolls: typed?.scrolls, scrolled, outside: outside.slice(0, 3) });
    await page.keyboard.press("Backspace");
    await page.waitForSelector(`${OPEN} [data-command-palette-group="start"] [data-command-palette-item]`, { state: "visible", timeout: 10_000 });
    // Enter runs the row that is selected and on screen: the last start action, People & agents.
    await page.keyboard.press("ArrowUp");
    const last = await read();
    await page.keyboard.press("Enter");
    const roster = await page.waitForSelector("dialog[data-roster-dialog][open]", { state: "visible", timeout: 10_000 }).then(() => true, () => false);
    check("Enter runs the selected row that is on screen", shown(last) && last!.item === "action:people" && roster && await page.evaluate(PALETTE) === null, { last, roster });
    await page.close();
    return { checks, error: null };
  } catch (error) {
    return { checks, error: String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300) };
  }
}
