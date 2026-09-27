// 기본 스타일을 가장 먼저 불러와야 화면별 스타일이 기본 규칙(.btn 등)을 덮어쓸 수 있다
import './styles/base.css';
import { createBrowserRouter, Navigate } from 'react-router';
import { AdminLayout, AdminLoginPage } from './admin/AdminLayout';
import { mountRouter } from './ui/mount-router';
import { NotFound } from './ui/NotFound';

/**
 * 관리자 웹 진입점(web/admin.html). 응시 화면 코드는 이 빌드에 들어 있지 않다.
 * 관리자 서버(ADMIN_WEB_DIST_DIR)가 제공한다. 화면별로 나눠 불러와 첫 화면을 가볍게 둔다.
 */
mountRouter(
  createBrowserRouter([
    { path: '/', element: <Navigate to="/admin" replace /> },
    { path: '/admin/login', element: <AdminLoginPage /> },
    {
      path: '/admin',
      element: <AdminLayout />,
      children: [
        { index: true, lazy: async () => ({ Component: (await import('./admin/ExamListPage')).ExamListPage }) },
        { path: 'exams/:examId', lazy: async () => ({ Component: (await import('./admin/ExamDetailPage')).ExamDetailPage }) },
        { path: 'sessions/:sessionId', lazy: async () => ({ Component: (await import('./admin/SessionDetailPage')).SessionDetailPage }) },
      ],
    },
    { path: '*', element: <NotFound homePath="/admin" homeLabel="시험 목록으로" /> },
  ]),
);
