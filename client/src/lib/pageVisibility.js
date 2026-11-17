// Voice preparation only counts while someone is looking at the page: the
// coordinator switches or starts a GPU only after ~8 s of continuous selection,
// so a background tab must not run that clock. Runs `fn` now if the page is
// visible, otherwise once it next becomes visible.
export function runWhenPageVisible(fn) {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    fn();
    return;
  }
  const onVisible = () => {
    if (document.visibilityState === 'hidden') return;
    document.removeEventListener('visibilitychange', onVisible);
    fn();
  };
  document.addEventListener('visibilitychange', onVisible);
}
