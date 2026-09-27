import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, type createBrowserRouter } from 'react-router';

/** 진입 HTML의 #root에 라우터를 붙인다. 수험생·관리자 진입점이 함께 쓴다 */
export function mountRouter(router: ReturnType<typeof createBrowserRouter>): void {
  const container = document.getElementById('root');
  if (container === null) throw new Error('#root 요소가 없습니다');
  createRoot(container).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
