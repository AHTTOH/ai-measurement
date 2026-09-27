import type { ChatMessageView } from '@ai-measurement/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { candidateApi } from '../api/candidate-client';
import { errorMessage } from '../api/http';

/**
 * 진행 중인 응답을 다시 읽는 간격. SSE 대신 짧은 요청을 반복한다.
 * Firebase Hosting은 SSE 응답을 끝까지 모아 한꺼번에 보내기 때문이다(2026-09-27 배포 확인, 결정 D18)
 */
const PROGRESS_POLL_MS = 500;
/** 진행 확인이 실패하면 이만큼 쉬었다 다시 한다(일시적인 네트워크 오류) */
const RETRY_AFTER_ERROR_MS = 2000;

export interface ConversationState {
  messages: ChatMessageView[];
  /** 응답을 받는 중이면 지금까지의 텍스트, 아니면 null */
  streamingText: string | null;
  failure: string | null;
  appendMessage: (message: ChatMessageView) => void;
  /** 응답이 끝날 때까지 진행 중인 텍스트를 따라간다 */
  followStream: () => void;
}

/**
 * 대화 하나의 메시지와 진행 중인 응답을 관리한다.
 * 새로고침이나 연결 끊김 뒤에도 서버가 들고 있는 응답을 지금까지의 텍스트부터 이어 보여 준다.
 * 응답이 끝나면 대화를 다시 읽어 저장된 응답(오류 응답 포함)을 보여 준다.
 */
export function useConversation(conversationId: string | null): ConversationState {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 대화가 바뀌거나 화면이 사라지면 올라가서 진행 중인 반복을 멈추게 한다 */
  const generation = useRef(0);

  const stop = useCallback(() => {
    generation.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    if (conversationId === null) return false;
    try {
      const detail = await candidateApi.conversation(conversationId);
      setMessages(detail.messages);
      return detail.streaming;
    } catch (error) {
      setFailure(errorMessage(error));
      return false;
    }
  }, [conversationId]);

  const followStream = useCallback(() => {
    if (conversationId === null) return;
    stop();
    const mine = generation.current;
    setStreamingText('');
    setFailure(null);
    const tick = async () => {
      if (generation.current !== mine) return;
      let delay = PROGRESS_POLL_MS;
      try {
        const progress = await candidateApi.progress(conversationId);
        if (generation.current !== mine) return;
        if (!progress.streaming) {
          setStreamingText(null);
          await load();
          return;
        }
        setStreamingText(progress.text);
      } catch (error) {
        setFailure(errorMessage(error));
        delay = RETRY_AFTER_ERROR_MS;
      }
      if (generation.current === mine) timer.current = setTimeout(() => void tick(), delay);
    };
    void tick();
  }, [conversationId, stop, load]);

  useEffect(() => {
    setMessages([]);
    setStreamingText(null);
    setFailure(null);
    void load().then((streaming) => {
      if (streaming) followStream();
    });
    return stop;
  }, [load, followStream, stop]);

  const appendMessage = useCallback((message: ChatMessageView) => setMessages((previous) => [...previous, message]), []);
  return { messages, streamingText, failure, appendMessage, followStream };
}
