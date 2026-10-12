import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
/** OK금융그룹 캐릭터 SD 읏맨 4세대. okfngroup.com 기업 아이덴티티 > 캐릭터 소개 이미지에서 잘라냈다(2026-10-01) */
import utmanSd from '../assets/brand/utman-sd.png';
import { BrandLogo, GROUP_LOGO } from '../ui/BrandLogo';
import { startLandingCanvas } from './landing-canvas';
import '../styles/landing.css';

/** PRD 1장 제품 개요의 평가 흐름 */
const FLOW = '판단 → AI 활용 → 결과 완성';
/**
 * 하단 띠의 OK금융그룹 계열사. 출처는 okfngroup.com 두 곳이다(2026-10-01 확인).
 * - 기업 아이덴티티 > CI 소개 > 'OK 계열사 시그니처' 이미지(16곳, 표기는 이것을 따른다)
 * - 하단 Family Site 목록(위에 없는 OK Bank Indonesia를 더했다)
 * 목록을 고칠 때는 위 두 곳을 다시 확인한다. 임의로 더하거나 빼지 않는다.
 */
const AFFILIATES = [
  'OK금융그룹',
  'OK홀딩스',
  'OK저축은행',
  'OK캐피탈',
  'OK AX',
  '아프로신용정보',
  '아프로에프앤아이대부',
  'OK인베스트먼트 파트너스',
  'OK벤처스',
  'OK네트웍스',
  'OK넥스트',
  'OK배·정 장학재단',
  '러시앤캐시',
  '미즈사랑',
  'OK Bank Indonesia',
  '부산 OK저축은행 읏맨 프로배구단',
  'OK저축은행 읏맨 럭비단',
] as const;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 메인 화면 틀: 로고 파티클 무대, 헤드라인, 로그인 카드(children), 하단 마키 */
export function LoginLanding({ children }: { children: ReactNode }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (canvas === null || stage === null) return;
    return startLandingCanvas(canvas, stage, GROUP_LOGO, prefersReducedMotion());
  }, []);

  return (
    <div className="landing">
      <canvas ref={canvasRef} className="landing-canvas" aria-hidden="true" />
      <header className="landing-top">
        <BrandLogo className="landing-top-logo" />
        <span className="landing-top-rule" aria-hidden="true" />
        <BrandLogo brand="bank" className="landing-top-logo landing-top-logo-bank" />
      </header>
      <main className="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <p className="landing-kicker">{FLOW}</p>
          <div ref={stageRef} className="landing-stage" aria-hidden="true" />
          <ScrambleTitle id="landing-title" text="AI 실무역량 평가" />
        </section>
        <div className="landing-aside">
          {/* 장식 그림이라 화면 읽기 도구에는 알리지 않는다 */}
          <img className="landing-mascot" src={utmanSd} alt="" width={480} height={655} decoding="async" />
          {children}
        </div>
      </main>
      <Marquee items={AFFILIATES} />
    </div>
  );
}

const HANGUL_POOL = '가나다라마바사아자차카타파하판단결과완성실무역량평가활용';
const LATIN_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#%&*/<>';

function randomGlyph(ch: string): string {
  if (ch.trim() === '') return ch;
  const pool = /[가-힣]/u.test(ch) ? HANGUL_POOL : LATIN_POOL;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * 글자가 해독되듯 제자리를 찾는 제목. 화면을 열 때 한 번만 돈다.
 * 커서가 지날 때마다 다시 돌리던 것은 산만하다는 피드백으로 뺐다(2026-10-01).
 * 화면 읽기 도구에는 원문만 전달한다.
 */
function ScrambleTitle({ id, text }: { id: string; text: string }): ReactElement {
  const [shown, setShown] = useState(text);
  const rafRef = useRef(0);

  const run = () => {
    if (prefersReducedMotion()) return;
    cancelAnimationFrame(rafRef.current);
    const chars = [...text];
    // 프레임 수가 아니라 시간으로 끝을 정해야 느린 기기에서도 제때 원문이 된다(ms)
    const settleAt = chars.map((_, i) => 140 + i * 50 + Math.random() * 230);
    const end = Math.max(...settleAt);
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      setShown(chars.map((ch, i) => (elapsed >= settleAt[i]! ? ch : randomGlyph(ch))).join(''));
      if (elapsed < end) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    run();
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // 처음 한 번만 해독 연출을 돌린다

  return (
    <h1 id={id} className="landing-title">
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true">{shown}</span>
    </h1>
  );
}

/**
 * 하단의 얇은 계열사 띠. CSS 애니메이션으로 일정하게 흐른다.
 * 같은 내용을 두 번 이어 붙여 절반(-50%)마다 이음매 없이 되감는다.
 * 큰 글자·외곽선·속도 반응 띠는 화면 아래를 무겁게 눌러 바꿨다(2026-10-01).
 */
function Marquee({ items }: { items: readonly string[] }): ReactElement {
  // 계열사 목록 한 번이 약 2,500px라 2560px 화면에서는 모자란다. 두 번 이은 것을 한 절반으로 쓴다
  const half = [...items, ...items];
  return (
    <div className="landing-marquee" aria-hidden="true">
      <div className="landing-marquee-track">
        {[...half, ...half].map((item, i) => (
          <span key={i} className="landing-marquee-item">
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
