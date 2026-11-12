import { fonts } from '../styles/tokens';
import { useColors } from '../components/shared/useColors';
import { useGuiProjects } from './useGuiProjects';

interface ChatPaneProps {
  projectId: string | null;
  onLiveChange: (live: boolean) => void;
}

/** Slice-1 T5 placeholder; the terminal + composer pane replaces this body. */
export function ChatPane({ projectId }: ChatPaneProps) {
  const colors = useColors();
  const { projects } = useGuiProjects();
  const name = projectId === null ? 'New chat' : (projects.find((p) => p.id === projectId)?.name ?? 'Project');
  return (
    <div data-testid="chat-pane" style={{ padding: 24, color: colors.textPrimary, font: `600 18px/1.3 ${fonts.ui}` }}>
      {name}
    </div>
  );
}
