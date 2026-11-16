import { useEffect, useId, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { CROP_STEP, FULL_PAGE, fullPageViewport, moveCropEdge, type PdfCrop } from './pdf-crop.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import './pdf-crop.css';

export function PdfCropDialog({ document, page, crop, onApply, onClose }: {
  document: PDFDocumentProxy; page: number; crop: PdfCrop; onApply: (crop: PdfCrop) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null), preview = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const title = useId(), hint = useId(), fields = useId();
  const [draft, setDraft] = useState<PdfCrop>(crop), [number, setNumber] = useState(page), [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(false), [error, setError] = useState(false);
  const drag = useRef<{ id: number; edge: number; start: number; value: number; size: number } | null>(null);
  const labels = [t('Left margin'), t('Top margin'), t('Right margin'), t('Bottom margin')];
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    let disposed = false, frame = 0, generation = 0, render: RenderTask | undefined;
    const draw = async () => {
      const own = ++generation;
      setReady(false); setError(false);
      render?.cancel();
      try {
        // A cancelled render must release its canvas before the next one starts.
        await render?.promise.catch(() => {});
        const pdfPage = await document.getPage(number);
        if (disposed || own !== generation) return;
        const area = stage.current!, full = fullPageViewport(pdfPage, { scale: 1 });
        const scale = Math.min((area.clientWidth - 48) / full.width, (area.clientHeight - 48) / full.height);
        if (scale <= 0) return;
        const viewport = fullPageViewport(pdfPage, { scale }), pixelRatio = Math.min(window.devicePixelRatio || 1, 2), target = canvas.current!;
        target.width = Math.ceil(viewport.width * pixelRatio); target.height = Math.ceil(viewport.height * pixelRatio);
        preview.current!.style.width = `${viewport.width}px`; preview.current!.style.height = `${viewport.height}px`;
        render = pdfPage.render({ canvas: target, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        await render.promise;
        if (!disposed && own === generation) setReady(true);
      } catch {
        if (!disposed && own === generation) setError(true);
      }
    };
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => void draw()); });
    observer.observe(stage.current!);
    return () => { disposed = true; generation++; observer.disconnect(); cancelAnimationFrame(frame); render?.cancel(); };
  }, [document, number, retry]);
  const margin = (edge: number) => Math.round((edge < 2 ? draft[edge] : 1 - draft[edge]) * 100);
  return <dialog ref={dialog} className="pdf-crop-dialog" aria-labelledby={title} onClose={onClose}>
    <header><h2 id={title}>{t('Crop margins')}</h2><button type="button" className="icon-button" aria-label={t('Close')} onClick={() => dialog.current!.close()}><Icon name="close"/></button></header>
    <p id={hint}>{t('Drag the edges or enter margins as percentages. Use arrow keys to move a focused edge.')}</p>
    <div className="pdf-crop-stage" ref={stage}>
      <div className="pdf-crop-preview" ref={preview} style={{ visibility: ready ? 'visible' : 'hidden' }}>
        <canvas ref={canvas} aria-label={t('Page {page}', { page: number })}/>
        <div className="pdf-crop-shade" style={{ clipPath: `polygon(0 0,100% 0,100% 100%,0 100%,0 0,${draft[0] * 100}% ${draft[1] * 100}%,${draft[0] * 100}% ${draft[3] * 100}%,${draft[2] * 100}% ${draft[3] * 100}%,${draft[2] * 100}% ${draft[1] * 100}%,${draft[0] * 100}% ${draft[1] * 100}%)` }}/>
        <div className="pdf-crop-outline" style={{ left: `${draft[0] * 100}%`, top: `${draft[1] * 100}%`, width: `${(draft[2] - draft[0]) * 100}%`, height: `${(draft[3] - draft[1]) * 100}%` }}/>
        {labels.map((label, edge) => <button key={edge} type="button" className={'pdf-crop-handle ' + (edge % 2 ? 'horizontal' : 'vertical')} aria-label={label} aria-describedby={hint}
          style={{ left: `${(edge % 2 ? (draft[0] + draft[2]) / 2 : draft[edge]) * 100}%`, top: `${(edge % 2 ? draft[edge] : (draft[1] + draft[3]) / 2) * 100}%` }}
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
            const box = preview.current!.getBoundingClientRect();
            drag.current = { id: event.pointerId, edge, start: edge % 2 ? event.clientY : event.clientX, value: draft[edge], size: edge % 2 ? box.height : box.width };
          }} onPointerMove={event => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            const delta = ((current.edge % 2 ? event.clientY : event.clientX) - current.start) / current.size;
            setDraft(value => moveCropEdge(value, current.edge, current.value + delta));
          }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => {
            const direction = edge % 2 ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 };
            const step = direction[event.key as keyof typeof direction];
            if (!step) return;
            event.preventDefault(); setDraft(value => moveCropEdge(value, edge, value[edge] + step * CROP_STEP));
          }}><span/></button>)}
      </div>
      {!ready && <div className="pdf-crop-status">{error ? <><p role="alert">{t('The page preview could not be loaded.')}</p><button type="button" className="button secondary" onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></> : <span className="spinner" aria-label={t('Loading…')}/>}</div>}
    </div>
    <div className="pdf-crop-page"><button type="button" className="icon-button" aria-label={t('Previous page')} disabled={number <= 1} onClick={() => setNumber(value => value - 1)}><Icon name="chevronLeft"/></button><span>{t('Page {page} of {pages}', { page: number, pages: document.numPages })}</span><button type="button" className="icon-button" aria-label={t('Next page')} disabled={number >= document.numPages} onClick={() => setNumber(value => value + 1)}><Icon name="chevronRight"/></button></div>
    <div className="pdf-crop-fields">{labels.map((label, edge) => <label key={edge} htmlFor={`${fields}-${edge}`}>{label}<span><input id={`${fields}-${edge}`} type="number" min="0" max={Math.round((edge < 2 ? draft[edge + 2] - CROP_STEP : 1 - draft[edge - 2] - CROP_STEP) * 100)} step="1" inputMode="numeric" value={margin(edge)} onChange={event => {
      const value = event.currentTarget.valueAsNumber;
      if (Number.isFinite(value)) setDraft(current => moveCropEdge(current, edge, edge < 2 ? value / 100 : 1 - value / 100));
    }}/>%</span></label>)}</div>
    <p className="pdf-crop-help">{t('Applies to every page. Saved on this device; exported PDFs keep their full margins.')}</p>
    <footer><button type="button" className="button secondary" onClick={() => { onApply(FULL_PAGE); dialog.current!.close(); }}>{t('Reset')}</button><div><button type="button" className="button secondary" autoFocus onClick={() => dialog.current!.close()}>{t('Cancel')}</button><button type="button" className="button primary" disabled={!ready} onClick={() => { onApply(draft); dialog.current!.close(); }}>{t('Apply')}</button></div></footer>
  </dialog>;
}
