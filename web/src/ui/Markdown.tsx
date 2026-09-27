import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** AI 응답·기준답안 표시용 마크다운. 원시 HTML은 렌더링하지 않는다(react-markdown 기본값) */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
