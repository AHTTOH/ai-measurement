// 기본 스타일을 가장 먼저 불러와야 화면별 스타일이 기본 규칙(.btn 등)을 덮어쓸 수 있다
import './styles/base.css';
import { createBrowserRouter } from 'react-router';
import { CandidateApp } from './candidate/CandidateApp';
import { mountRouter } from './ui/mount-router';
import { NotFound } from './ui/NotFound';

/**
 * 수험생 웹 진입점(web/index.html). 관리자 화면 코드는 이 빌드에 들어 있지 않다.
 * 수험생 서버(CANDIDATE_WEB_DIST_DIR)가 제공한다.
 */
mountRouter(
  createBrowserRouter([
    { path: '/', element: <CandidateApp /> },
    { path: '*', element: <NotFound homePath="/" homeLabel="응시 화면으로" /> },
  ]),
);
