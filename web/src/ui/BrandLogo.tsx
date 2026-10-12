import type { ReactElement } from 'react';
import groupLogo from '../assets/brand/okfngroup-logo.png';
import groupLogoOnDark from '../assets/brand/okfngroup-logo-on-dark.png';
import bankLogo from '../assets/brand/oksavingsbank-logo.png';
import bankLogoOnDark from '../assets/brand/oksavingsbank-logo-on-dark.png';

/**
 * OK금융그룹·OK저축은행 시그니처. 원본은 각 공식 사이트의 로고 파일이다(2026-10-01 수집).
 * 어두운 바탕용(on-dark)은 CI의 Black BG 풀컬러 규정대로 갈색 글자만 흰색으로 바꾼 것이다.
 */
const LOGOS = {
  group: { light: groupLogo, dark: groupLogoOnDark, alt: 'OK금융그룹', width: 1363, height: 246 },
  bank: { light: bankLogo, dark: bankLogoOnDark, alt: 'OK저축은행', width: 468, height: 144 },
} as const;

export const GROUP_LOGO = groupLogo;

export function BrandLogo({ brand = 'group', tone = 'light', className }: { brand?: keyof typeof LOGOS; tone?: 'light' | 'dark'; className?: string }): ReactElement {
  const logo = LOGOS[brand];
  return <img src={tone === 'dark' ? logo.dark : logo.light} alt={logo.alt} width={logo.width} height={logo.height} className={className} decoding="async" />;
}
