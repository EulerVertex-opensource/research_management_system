import React, { useEffect, useId, useState } from 'react';
import { COLOR, tint } from '../graph/colors';

/**
 * The agent's status mark: a small copy of the AI_teaching landing hero (the
 * EulerVertex logo). While `active`, routes light up node by node; otherwise
 * it holds still with the first route lit. Every color is a shade of `color`,
 * so the mark takes on the state it reports. Reduced-motion users get the
 * still mark. Its styles are agent-constellation.css, imported by index.tsx.
 */

interface Props {
  /** The agent is working: animate. */
  active: boolean;
  /** The state's color, a `COLOR` value. */
  color: string;
  /** Width and height in pixels. */
  size?: number;
  title?: string;
  style?: React.CSSProperties;
}

interface ConstellationEdge {
  from: number;
  to: number;
  /** Quadratic-curve control point, for the logo's one curved edge. */
  curve?: { x: number; y: number };
  /** Not drawn at rest; only while a route travels it. */
  hiddenAtRest?: boolean;
}

/* The logo's node centers, measured on its 500x500 canvas. */
const NODES = [
  { x: 105, y: 123 }, // top-left
  { x: 243, y: 238 }, // hub
  { x: 129, y: 385 }, // bottom-left
  { x: 377, y: 352 }, // bottom-right
  { x: 400, y: 186 }, // right, free-standing
];

const EDGES: ConstellationEdge[] = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
  { from: 1, to: 3 },
  { from: 2, to: 3, curve: { x: 250, y: 420 } },
  { from: 3, to: 4, hiddenAtRest: true },
];

/** Paths the animation lights up in turn, as indexes into NODES. */
const ROUTES: number[][] = [
  [0, 1, 2, 3, 4],
  [0, 1, 3, 4],
];

/* Heavier than the hero's 27/9, so the mark still reads at icon size; the
   view box is cropped to the logo. */
const NODE_R = 46;
const STROKE = 26;
const VIEW_BOX = '42 44 420 420';
const STEP_MS = 650;
const HOLD_MS = 3600;

const routeDuration = (route: number[]) => (route.length - 1) * STEP_MS + HOLD_MS;

const stepDelay = (i: number, extraMs = 0) => ({ '--hc-delay': `${(i * STEP_MS + extraMs) / 1000}s` }) as React.CSSProperties;

/** An edge's path from node `a` toward node `b`, so a route draws in the direction it travels. */
function edgePath(edge: ConstellationEdge, a: number, b: number): string {
  const p = NODES[a];
  const q = NODES[b];
  return edge.curve ? `M ${p.x} ${p.y} Q ${edge.curve.x} ${edge.curve.y} ${q.x} ${q.y}` : `M ${p.x} ${p.y} L ${q.x} ${q.y}`;
}

function findEdge(a: number, b: number): ConstellationEdge {
  const edge = EDGES.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  if (!edge) throw new Error(`constellation: no edge ${a}-${b}`);
  return edge;
}

/** Live `prefers-reduced-motion: reduce`, for the timer that advances routes; the CSS handles the animations. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function AgentConstellation({ active, color, size = 30, title, style }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const [routeIndex, setRouteIndex] = useState(0);
  // Unique per instance, and stripped to characters url(#...) accepts.
  const glowId = `hc-glow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const moving = active && !reducedMotion;

  const route = moving ? ROUTES[routeIndex] : ROUTES[0];
  const duration = routeDuration(route);

  useEffect(() => {
    if (!moving) return;
    const timer = window.setTimeout(() => setRouteIndex((i) => (i + 1) % ROUTES.length), duration);
    return () => window.clearTimeout(timer);
  }, [routeIndex, duration, moving]);

  const theme = {
    '--hc-glow': tint(color, 30),
    '--hc-rest': tint(color, 35),
    '--hc-accent': color,
    '--hc-lit': tint(color, 30),
    '--hc-surface': COLOR.card,
    width: size,
    height: size,
    ...style,
  } as React.CSSProperties;
  const routeFade = { '--hc-cycle': `${duration}ms` } as React.CSSProperties;

  return (
    <span className={`hero-constellation${moving ? '' : ' hc-still'}`} style={theme} title={title} aria-hidden="true">
      <svg viewBox={VIEW_BOX}>
        <defs>
          <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--hc-glow)" stopOpacity="0.6" />
            <stop offset="100%" stopColor="var(--hc-glow)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {moving && <circle cx={252} cy={254} r={210} fill={`url(#${glowId})`} />}

        {/* The logo at rest, in muted tones. */}
        <g fill="none" stroke="var(--hc-rest)" strokeWidth={STROKE} strokeLinecap="round">
          {EDGES.filter((e) => !e.hiddenAtRest).map((e) => <path key={`${e.from}-${e.to}`} d={edgePath(e, e.from, e.to)} />)}
        </g>

        {/* The current route's edges, drawn in the direction it travels. */}
        <g key={`edges-${routeIndex}`} className="hc-route-fade" style={routeFade} fill="none" stroke="var(--hc-accent)" strokeWidth={STROKE} strokeLinecap="round">
          {route.slice(1).map((to, i) => {
            const from = route[i];
            return <path key={`${from}-${to}`} className="hc-draw" style={stepDelay(i, 180)} pathLength={1} d={edgePath(findEdge(from, to), from, to)} />;
          })}
        </g>

        <g fill="var(--hc-surface)" stroke="var(--hc-rest)" strokeWidth={STROKE}>
          {NODES.map((n, i) => <circle key={i} cx={n.x} cy={n.y} r={NODE_R} />)}
        </g>

        {/* The current route's nodes, lit. */}
        <g key={`nodes-${routeIndex}`} className="hc-route-fade" style={routeFade}>
          {route.map((nodeIndex, i) => {
            const n = NODES[nodeIndex];
            return <circle key={nodeIndex} className="hc-pop" style={stepDelay(i)} cx={n.x} cy={n.y} r={NODE_R} fill="var(--hc-lit)" stroke="var(--hc-accent)" strokeWidth={STROKE} />;
          })}
        </g>
      </svg>
    </span>
  );
}
