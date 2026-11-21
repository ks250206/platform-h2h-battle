interface ZoomWindow {
  visualViewport?: Pick<
    VisualViewport,
    "addEventListener" | "scale" | "offsetLeft" | "offsetTop" | "width"
  > | null;
  ongesturestart?: unknown;
  scrollTo(x: number, y: number): void;
}

export function installZoomGuard(win: ZoomWindow = window, doc: Document = document): () => void {
  const root = doc.documentElement;
  const viewport = win.visualViewport;
  const abort = new AbortController();
  const { signal } = abort;
  const cancelable = { passive: false, signal };
  const zoomed = () => root.hasAttribute("data-zoomed");
  const scrollHome = () => win.scrollTo(0, 0);

  const blockPinch = (event: Event) => {
    if (!zoomed() && event.cancelable) event.preventDefault();
  };
  doc.addEventListener("gesturestart", blockPinch, cancelable);
  doc.addEventListener("gesturechange", blockPinch, cancelable);
  doc.addEventListener("focusout", scrollHome, { signal });

  if ("ongesturestart" in win) {
    let previousTap: { time: number; x: number; y: number } | null = null;
    doc.addEventListener(
      "touchend",
      (event) => {
        const target = event.target;
        if (
          zoomed() ||
          event.changedTouches.length !== 1 ||
          event.touches?.length ||
          !(target instanceof Element) ||
          target.closest("input, select, textarea, .touch-controls")
        ) {
          previousTap = null;
          return;
        }
        const { clientX: x, clientY: y } = event.changedTouches[0];
        const time = event.timeStamp;
        if (
          previousTap &&
          time - previousTap.time <= 350 &&
          Math.hypot(x - previousTap.x, y - previousTap.y) <= 40 &&
          event.cancelable
        ) {
          previousTap = null;
          event.preventDefault();
          const control = target.closest<HTMLElement>("button, a, summary, label");
          if (control && !control.matches(":disabled")) control.click();
        } else {
          previousTap = { time, x, y };
        }
      },
      cancelable,
    );
  }

  const notice = doc.createElement("aside");
  notice.className = "zoom-notice";
  notice.hidden = true;
  notice.innerHTML =
    '<span role="status">画面が拡大されています。2本指でつまんで戻せます</span><button type="button">元の表示に戻す</button>';
  notice.querySelector("button")!.addEventListener(
    "click",
    () => {
      const meta = doc.querySelector('meta[name="viewport"]');
      const content = meta?.getAttribute("content");
      if (meta && content !== null && content !== undefined) {
        meta.removeAttribute("content");
        meta.setAttribute("content", content);
      }
      scrollHome();
    },
    { signal },
  );
  doc.body.append(notice);

  if (viewport) {
    const sync = () => {
      const enlarged = viewport.scale > 1.02;
      root.toggleAttribute("data-zoomed", enlarged);
      notice.hidden = !enlarged;
      if (enlarged) {
        notice.style.left = `${viewport.offsetLeft}px`;
        notice.style.top = `${viewport.offsetTop}px`;
        notice.style.setProperty("--zoom-viewport-width", `${viewport.width}px`);
      } else {
        scrollHome();
      }
    };
    viewport.addEventListener("resize", sync, { signal });
    viewport.addEventListener("scroll", sync, { signal });
    sync();
  }

  return () => {
    abort.abort();
    root.removeAttribute("data-zoomed");
    notice.remove();
  };
}
