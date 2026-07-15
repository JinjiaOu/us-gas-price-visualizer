import { useEffect, useRef } from "react";

type Theme = "dark" | "light";

type Point = {
  x: number;
  y: number;
};

const FIELD_STEP = 34;
const LEVELS = [-0.52, -0.34, -0.18, -0.04, 0.12, 0.28, 0.44, 0.6];

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function fieldValue(x: number, y: number, t: number): number {
  const nx = x * 0.0068;
  const ny = y * 0.0074;

  return (
    Math.sin(nx * 1.6 + t * 0.26) * 0.42 +
    Math.cos(ny * 1.25 - t * 0.18) * 0.35 +
    Math.sin((nx + ny) * 1.1 + t * 0.12) * 0.32 +
    Math.cos(Math.hypot(x - 260, y - 180) * 0.012 - t * 0.22) * 0.22 +
    Math.sin(Math.hypot(x - 920, y - 640) * 0.009 + t * 0.17) * 0.26
  );
}

function interp(a: Point, b: Point, av: number, bv: number, level: number): Point {
  const span = bv - av;
  const k = Math.abs(span) < 0.00001 ? 0.5 : (level - av) / span;
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
  };
}

function drawContourLines(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number,
  color: string,
) {
  const cols = Math.ceil(width / FIELD_STEP) + 2;
  const rows = Math.ceil(height / FIELD_STEP) + 2;
  const values: number[][] = [];

  for (let y = 0; y <= rows; y += 1) {
    values[y] = [];
    for (let x = 0; x <= cols; x += 1) {
      values[y][x] = fieldValue(x * FIELD_STEP, y * FIELD_STEP, t);
    }
  }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  ctx.globalCompositeOperation = "source-over";

  for (const level of LEVELS) {
    ctx.beginPath();

    for (let gy = 0; gy < rows; gy += 1) {
      for (let gx = 0; gx < cols; gx += 1) {
        const x = gx * FIELD_STEP;
        const y = gy * FIELD_STEP;
        const p0 = { x, y };
        const p1 = { x: x + FIELD_STEP, y };
        const p2 = { x: x + FIELD_STEP, y: y + FIELD_STEP };
        const p3 = { x, y: y + FIELD_STEP };
        const v0 = values[gy][gx];
        const v1 = values[gy][gx + 1];
        const v2 = values[gy + 1][gx + 1];
        const v3 = values[gy + 1][gx];
        const points: Point[] = [];

        if ((v0 < level) !== (v1 < level)) points.push(interp(p0, p1, v0, v1, level));
        if ((v1 < level) !== (v2 < level)) points.push(interp(p1, p2, v1, v2, level));
        if ((v2 < level) !== (v3 < level)) points.push(interp(p2, p3, v2, v3, level));
        if ((v3 < level) !== (v0 < level)) points.push(interp(p3, p0, v3, v0, level));

        if (points.length === 2) {
          ctx.moveTo(points[0].x, points[0].y);
          ctx.lineTo(points[1].x, points[1].y);
        } else if (points.length === 4) {
          ctx.moveTo(points[0].x, points[0].y);
          ctx.lineTo(points[1].x, points[1].y);
          ctx.moveTo(points[2].x, points[2].y);
          ctx.lineTo(points[3].x, points[3].y);
        }
      }
    }

    ctx.stroke();
  }

  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < width; x += 96) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y < height; y += 96) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }

  ctx.stroke();
  ctx.restore();
}

export function ContourBackground({ theme }: { theme: Theme }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return undefined;

    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const render = (time: number) => {
      const t = reducedMotion ? 0 : time * 0.001;
      const lineColor = theme === "dark"
        ? cssVar("--contour-line", "rgba(90, 220, 204, 0.18)")
        : cssVar("--contour-line", "rgba(55, 84, 98, 0.12)");
      const gridColor = theme === "dark"
        ? cssVar("--contour-grid", "rgba(255, 255, 255, 0.035)")
        : cssVar("--contour-grid", "rgba(35, 42, 50, 0.035)");
      const glowColor = theme === "dark"
        ? cssVar("--contour-glow", "rgba(255, 109, 56, 0.08)")
        : cssVar("--contour-glow", "rgba(207, 61, 16, 0.055)");

      ctx.clearRect(0, 0, width, height);
      drawGrid(ctx, width, height, gridColor);

      const driftX = reducedMotion ? 0 : Math.sin(t * 0.08) * 18;
      const driftY = reducedMotion ? 0 : Math.cos(t * 0.07) * 14;
      ctx.save();
      ctx.translate(driftX, driftY);
      drawContourLines(ctx, width + FIELD_STEP * 2, height + FIELD_STEP * 2, t, lineColor);
      ctx.restore();

      const glow = ctx.createRadialGradient(
        width * 0.72,
        height * 0.2,
        0,
        width * 0.72,
        height * 0.2,
        Math.max(width, height) * 0.72,
      );
      glow.addColorStop(0, glowColor);
      glow.addColorStop(0.55, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      if (!reducedMotion) raf = requestAnimationFrame(render);
    };

    resize();
    window.addEventListener("resize", resize);
    render(0);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [theme]);

  return <canvas ref={canvasRef} className="contour-bg" aria-hidden="true" />;
}
