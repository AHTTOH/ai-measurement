import type { ReactElement } from 'react';
import { Link } from 'react-router';

export interface NotFoundProps {
  homePath: string;
  homeLabel: string;
}

export function NotFound({ homePath, homeLabel }: NotFoundProps): ReactElement {
  return (
    <main className="entry">
      <p>
        없는 화면입니다. <Link to={homePath}>{homeLabel}</Link>
      </p>
    </main>
  );
}
