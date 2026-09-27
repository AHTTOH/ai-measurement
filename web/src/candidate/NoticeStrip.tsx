import type { CandidateNoticeView } from '@ai-measurement/shared';

interface NoticeStripProps {
  notices: Array<CandidateNoticeView & { caseTitle: string }>;
  onAcknowledge: (noticeKey: string) => void;
}

/** 진행 중 조건 변경 공지(PRD 7장). 확인하기 전까지 계기판 아래에 남는다 */
export function NoticeStrip({ notices, onAcknowledge }: NoticeStripProps) {
  if (notices.length === 0) return null;
  return (
    <section className="notice-strip" aria-live="assertive" aria-label="새 공지">
      {notices.map((notice) => (
        <article key={notice.key} className="notice">
          <div className="notice-body">
            <p className="notice-from">
              {notice.caseTitle} <span className="muted">보낸 사람: {notice.from}</span>
            </p>
            <h2 className="notice-title">{notice.title}</h2>
            <p className="prewrap">{notice.body}</p>
          </div>
          <button type="button" className="btn" onClick={() => onAcknowledge(notice.key)}>
            확인
          </button>
        </article>
      ))}
    </section>
  );
}
