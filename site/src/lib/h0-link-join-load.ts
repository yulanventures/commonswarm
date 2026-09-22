/** Plain sentence. The module's own error text stays off the page. */
export const LINK_JOIN_LOAD_ERROR =
  "The invite controls did not load. Reload this page.";

/** Run `run` when the invite module loads. On failure, show `LINK_JOIN_LOAD_ERROR`. */
export function callLinkJoin<T>(
  loaded: Promise<T> | null,
  run: (module: T) => void,
  showError: (message: string) => void,
): void {
  if (loaded === null) return;
  void loaded.then(
    (module) => {
      run(module);
    },
    () => {
      showError(LINK_JOIN_LOAD_ERROR);
    },
  );
}
