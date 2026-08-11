import { useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { Button } from '../shared/Button';
import { appliedSummary } from '../../shared/optimizeGrade';
import type { OptimizeFinding, OptimizeSummary } from '../../shared/optimizeRules';
import type { GradeRow } from '../../shared/optimizeGrade';
import { findProjectByKey } from '../projects/projectsMath';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

type Target = { path: string; exists: boolean };
type Targets = { global: Target; project: Target | null };
type ApplyResult = { ok: boolean; added?: boolean; alreadyPresent?: boolean; targetPath?: string; backupPath?: string | null; error?: string };

export function resolveOptimizeViewData(state: {
  selectedProject: string | null;
  projectsSnapshot: ProjectsSnapshot | null;
  optimizeFindings: OptimizeFinding[];
  optimizeSummary: OptimizeSummary;
  optimizeBreakdown: GradeRow[];
}): {
  findings: (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[];
  summary: OptimizeSummary;
  breakdown: GradeRow[];
} {
  const scoped = findProjectByKey(state.projectsSnapshot, state.selectedProject);
  if (scoped) return { findings: scoped.optimize.findings, summary: scoped.optimize.summary, breakdown: scoped.optimize.breakdown };
  return { findings: state.optimizeFindings, summary: state.optimizeSummary, breakdown: state.optimizeBreakdown };
}

export function OptimizeView() {
  const colors = useColors();
  const { state } = useAetherStore();
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const { findings, summary, breakdown } = resolveOptimizeViewData(state);
  const appliedFindings: (OptimizeFinding & { applied?: boolean })[] = findings.map((f) => ({
    ...f,
    applied: appliedIds.has(f.id),
  }));
  const applied = appliedSummary(appliedFindings);

  return (
    <div style={rootStyle}>
      <div style={headerRowStyle()}>
        <div style={titleStyle(colors)}>⚡ OPTIMIZE</div>
        <div style={summaryLineStyle(colors)}>
          {applied.count > 0
            ? `${applied.count} applied · saving ~$${applied.totalPerWeek.toFixed(2)}/wk`
            : `est. save ~$${summary.totalPerWeek.toFixed(2)}/wk`}
        </div>
        <Button onClick={() => setBreakdownOpen((v) => !v)} style={gradeBtnStyle(colors)}>
          Setup {summary.grade} ▾
        </Button>
      </div>

      {breakdownOpen && (
        <div style={breakdownPanelStyle(colors)}>
          {breakdown.map((row) => (
            <div key={row.key} style={breakdownRowStyle}>
              <span style={statusGlyphStyle(colors, row.status)}>●</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={breakdownLabelStyle(colors)}>{row.label}</div>
                <div style={breakdownNoteStyle(colors)}>{row.note}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={listStyle}>
        {findings.length === 0 && <div style={emptyStyle(colors)}>Looking healthy — no findings.</div>}
        {findings.map((f) => (
          <FindingCard
            key={f.id}
            finding={f}
            colors={colors}
            pickerOpen={pickerFor === f.id}
            onTogglePicker={() => setPickerFor((cur) => (cur === f.id ? null : f.id))}
            onApplied={() => {
              setAppliedIds((cur) => new Set(cur).add(f.id));
              setPickerFor(null);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function FindingCard({
  finding,
  colors,
  pickerOpen,
  onTogglePicker,
  onApplied,
}: {
  finding: OptimizeFinding & { recurring?: true };
  colors: ColorPalette;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onApplied: () => void;
}) {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function openPicker() {
    onTogglePicker();
    if (!targets) {
      const t = await window.aetherElectron?.optimize.targets();
      if (t) setTargets(t);
    }
  }

  async function apply(target: 'global' | 'project') {
    setStatus(null);
    const result: ApplyResult | undefined = await window.aetherElectron?.optimize.apply({ findingId: finding.id, target });
    if (!result) return;
    if (!result.ok) {
      setStatus(result.error || 'Failed to apply');
      return;
    }
    setStatus(result.alreadyPresent ? 'Already applied' : 'Applied to CLAUDE.md (backed up)');
    onApplied();
    setTimeout(() => setStatus(null), 900);
  }

  return (
    <div style={cardStyle(colors)}>
      <div style={cardTitleStyle(colors)}>{finding.title}</div>
      <div style={cardDetailStyle(colors)}>{finding.detail}</div>
      {finding.recurring && <div style={recurringLineStyle(colors)}>Still happening despite guidance</div>}
      <div style={cardFooterStyle}>
        <span style={savingsStyle(colors)}>~${finding.estSavingsPerWeek.toFixed(2)}/wk</span>
        <div style={{ position: 'relative' }}>
          <Button onClick={openPicker} style={applyBtnStyle(colors)}>
            {finding.recurring ? 'Reapply fix' : 'Apply fix'}
          </Button>
          {pickerOpen && (
            <div style={pickerPanelStyle(colors)}>
              {!targets && <div style={emptyStyle(colors)}>loading targets…</div>}
              {targets && (
                <>
                  <Button onClick={() => apply('global')} style={targetOptionStyle(colors)}>
                    Global — {targets.global.path}
                  </Button>
                  {targets.project ? (
                    <Button onClick={() => apply('project')} style={targetOptionStyle(colors)}>
                      Project (most recent activity) — {targets.project.path}
                    </Button>
                  ) : (
                    <div style={emptyStyle(colors)}>no active project detected</div>
                  )}
                </>
              )}
              {status && <div style={statusLineStyle(colors)}>{status}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 };

function headerRowStyle(): CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 14, flex: 'none' };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `700 15px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textPrimary };
}
function summaryLineStyle(colors: ColorPalette): CSSProperties {
  return { flex: 1, font: `400 12px/1 ${fonts.mono}`, color: colors.textDim };
}
function gradeBtnStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    font: `600 12px/1 ${fonts.ui}`,
    color: colors.accentCyanSoft,
  };
}
function breakdownPanelStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    padding: 12,
    borderRadius: 10,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };
}
const breakdownRowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8 };
function statusGlyphStyle(colors: ColorPalette, status: 'good' | 'warn' | 'bad'): CSSProperties {
  const color = status === 'good' ? colors.success : status === 'warn' ? colors.warn : colors.danger;
  return { color, font: `700 10px/1.4 ${fonts.mono}` };
}
function breakdownLabelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, color: colors.textPrimary };
}
function breakdownNoteStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 2, font: `400 11px/1.3 ${fonts.ui}`, color: colors.textDim };
}
const listStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 };
function emptyStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
}
function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 14,
    borderRadius: 12,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
  };
}
function cardTitleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary };
}
function cardDetailStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 4, font: `400 12px/1.4 ${fonts.ui}`, color: colors.textDim };
}
function recurringLineStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 6, font: `600 11px/1 ${fonts.ui}`, color: colors.warn };
}
const cardFooterStyle: CSSProperties = { marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
function savingsStyle(colors: ColorPalette): CSSProperties {
  return { font: `700 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft };
}
function applyBtnStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelGradient,
    font: `600 11px/1 ${fonts.ui}`,
    color: colors.textPrimary,
  };
}
function pickerPanelStyle(colors: ColorPalette): CSSProperties {
  return {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 6,
    width: 320,
    zIndex: 70,
    padding: 12,
    borderRadius: 10,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    boxShadow: '0 20px 60px rgba(0,0,0,.6)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };
}
function targetOptionStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: '8px 10px',
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelGradient,
    font: `400 11px/1.3 ${fonts.mono}`,
    color: colors.textPrimary,
    textAlign: 'left',
    wordBreak: 'break-all',
  };
}
function statusLineStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1.3 ${fonts.ui}`, color: colors.accentCyanSoft };
}
