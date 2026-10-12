/**
 * 메인(로그인) 화면 로고 파티클. 화면 전체를 덮는 캔버스 하나와 rAF 하나로 그린다.
 * 로고 이미지의 불투명 픽셀을 샘플링한 점들이 흩어진 자리에서 모여 로고가 된다.
 * 포인터 근처 점은 밀려나고, 무대를 누르면 터졌다가 다시 모인다.
 * 별가루 커서는 흰 바탕에서 어색하다는 피드백으로 뺐다(2026-10-01).
 * 기법 출처: AHTTOH/design-lab (AFTER DARK II 파티클 모프)
 */

const CONFIG = {
  maxDots: 6000,
  maxDotsCompact: 2600,
  /** 점 한 변 = 샘플 간격 × 이 값. 간격이 넓어지면 점도 커져 글자가 읽힌다 */
  dotFill: 0.85,
  compactWidth: 860,
  dprCap: 1.5,
  spring: 0.045,
  damping: 0.86,
  repelRadius: 110,
  repelForce: 2.4,
  burstForce: 26,
  breathe: 0.6,
} as const;

/** 로고 픽셀 색을 CI 세 색(다크 브라운·오렌지·옐로)으로 묶어 색마다 한 번에 칠한다 */
const PALETTE = ['#55464a', '#f04922', '#faa619'] as const;

interface Dot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  tone: number;
  phase: number;
}

function nearestTone(r: number, g: number, b: number): number {
  // 채도가 낮으면 글자색(브라운), 아니면 초록 성분으로 옐로와 오렌지를 가른다
  if (Math.max(r, g, b) - Math.min(r, g, b) < 60) return 0;
  return g > 130 ? 2 : 1;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`로고를 불러오지 못했습니다: ${src}`));
    img.src = src;
  });
}

/** 무대 상자 안에 로고를 맞춰 그리고 점 목표 좌표(무대 왼쪽 위 기준)를 뽑는다 */
function sampleTargets(img: HTMLImageElement, box: DOMRect, maxDots: number): { points: Array<{ x: number; y: number; tone: number }>; step: number } {
  const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d', { willReadFrequently: true });
  if (octx === null) return { points: [], step: 2 };
  octx.drawImage(img, 0, 0, w, h);
  const data = octx.getImageData(0, 0, w, h).data;
  const top = (box.height - h) / 2;

  for (let step = 2; ; step++) {
    const points: Array<{ x: number; y: number; tone: number }> = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        if (data[i + 3]! > 140) points.push({ x, y: top + y, tone: nearestTone(data[i]!, data[i + 1]!, data[i + 2]!) });
      }
    }
    if (points.length <= maxDots || step > 12) return { points, step };
  }
}

export function startLandingCanvas(canvas: HTMLCanvasElement, stage: HTMLElement, logoSrc: string, reduceMotion: boolean): () => void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return () => undefined;

  let dpr = 1;
  let dots: Dot[] = [];
  let dotSize = 1.6;
  let img: HTMLImageElement | null = null;
  let pointer: { x: number; y: number } | null = null;
  let raf = 0;
  let disposed = false;

  const layout = () => {
    dpr = Math.min(window.devicePixelRatio || 1, CONFIG.dprCap);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    if (img === null) return;
    const compact = window.innerWidth < CONFIG.compactWidth;
    const { points: targets, step: gap } = sampleTargets(img, stage.getBoundingClientRect(), compact ? CONFIG.maxDotsCompact : CONFIG.maxDots);
    dotSize = Math.max(1.4, gap * CONFIG.dotFill);
    dots = targets.map((t, i) => {
      const prev = dots[i];
      return prev !== undefined
        ? { ...prev, tx: t.x, ty: t.y, tone: t.tone }
        : {
            // 처음에는 화면 곳곳에 흩어져 있다가 모인다
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            vx: 0,
            vy: 0,
            tx: t.x,
            ty: t.y,
            tone: t.tone,
            phase: Math.random() * Math.PI * 2,
          };
    });
    if (reduceMotion) settle();
  };

  /** 움직임 줄이기: 점을 목표 자리에 바로 두고 한 번만 그린다 */
  const settle = () => {
    const box = stage.getBoundingClientRect();
    for (const d of dots) {
      d.x = box.left + d.tx;
      d.y = box.top + d.ty;
    }
    draw();
  };

  const draw = () => {
    // 캔버스 폭은 innerWidth×dpr 을 반올림한 값이라 CSS 픽셀로 지우면 마지막 열이 남는다
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (let tone = 0; tone < PALETTE.length; tone++) {
      ctx.fillStyle = PALETTE[tone]!;
      ctx.beginPath();
      for (const d of dots) {
        if (d.tone !== tone) continue;
        ctx.rect(d.x, d.y, dotSize, dotSize);
      }
      ctx.fill();
    }
  };

  const step = (time: number) => {
    const t = time / 1000;
    const r2 = CONFIG.repelRadius * CONFIG.repelRadius;
    // 무대가 스크롤로 움직이면 점이 따라오며 살짝 끌린다
    const box = stage.getBoundingClientRect();
    for (const d of dots) {
      const tx = box.left + d.tx + Math.sin(t * 1.3 + d.phase) * CONFIG.breathe;
      const ty = box.top + d.ty + Math.cos(t * 1.1 + d.phase) * CONFIG.breathe;
      d.vx += (tx - d.x) * CONFIG.spring;
      d.vy += (ty - d.y) * CONFIG.spring;
      if (pointer !== null) {
        const dx = d.x - pointer.x;
        const dy = d.y - pointer.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < r2 && dist2 > 0.01) {
          const dist = Math.sqrt(dist2);
          const f = (1 - dist / CONFIG.repelRadius) * CONFIG.repelForce;
          d.vx += (dx / dist) * f;
          d.vy += (dy / dist) * f;
        }
      }
      d.vx *= CONFIG.damping;
      d.vy *= CONFIG.damping;
      d.x += d.vx;
      d.y += d.vy;
    }
    draw();
    raf = requestAnimationFrame(step);
  };

  const onPointerMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
  };
  const onPointerLeave = () => {
    pointer = null;
  };
  const onBurst = (e: PointerEvent) => {
    if (reduceMotion) return;
    for (const d of dots) {
      const dx = d.x - e.clientX;
      const dy = d.y - e.clientY;
      const dist = Math.max(Math.hypot(dx, dy), 8);
      const f = CONFIG.burstForce * (0.4 + Math.random() * 0.6) * Math.min(1, 220 / dist);
      d.vx += (dx / dist) * f;
      d.vy += (dy / dist) * f;
    }
  };
  const onVisibility = () => {
    cancelAnimationFrame(raf);
    if (!document.hidden && !reduceMotion && !disposed) raf = requestAnimationFrame(step);
  };

  const resizeObserver = new ResizeObserver(() => layout());
  resizeObserver.observe(stage);
  window.addEventListener('resize', layout);
  const onScroll = () => {
    if (reduceMotion) settle();
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onPointerLeave);
  stage.addEventListener('pointerdown', onBurst);
  document.addEventListener('visibilitychange', onVisibility);

  loadImage(logoSrc).then(
    (loaded) => {
      if (disposed) return;
      img = loaded;
      layout();
      if (!reduceMotion) raf = requestAnimationFrame(step);
    },
    () => undefined,
  );

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    window.removeEventListener('resize', layout);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('pointermove', onPointerMove);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    stage.removeEventListener('pointerdown', onBurst);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
