"use client";

import { useEffect, useRef } from "react";

/**
 * HeroFlowCanvas — lightweight raw-WebGL2 hero background.
 *
 * Layers (back → front, all in a single fragment shader):
 *   1. fBm light-smoke beam  — sweeping violet/gold gaussian hot-spot
 *   2. Micro-grain texture   — fast hash noise scrolling with time
 *   3. Particle field        — ~320 drifting dots whose paths are driven by
 *                              layered sine waves; particles near the cursor
 *                              bow away gently (u_mouse uniform updated via
 *                              pointermove on the parent section).
 *
 * Engineering:
 *   - Zero new dependencies — raw WebGL2, one fullscreen quad.
 *   - DPR capped at 1.5, powerPreference "low-power".
 *   - IntersectionObserver pauses rAF when off-screen.
 *   - prefers-reduced-motion → canvas hidden, CSS fog fallback shows.
 *   - Cursor is tracked on the nearest <section> ancestor so the hit area
 *     matches the visible hero rather than just the canvas element itself.
 */
export function HeroFlowCanvas({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Reduced-motion: hide canvas entirely.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) {
      canvas.style.display = "none";
      return;
    }

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      canvas.style.display = "none";
      return;
    }

    // ── Vertex shader (unchanged fullscreen quad) ────────────────────────────
    const vert = /* glsl */ `#version 300 es
      in  vec2 a_pos;
      out vec2 v_uv;
      void main() {
        v_uv        = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    // ── Fragment shader ───────────────────────────────────────────────────────
    const frag = /* glsl */ `#version 300 es
      precision mediump float;

      uniform float u_time;
      uniform vec2  u_res;
      uniform vec2  u_mouse;   // normalised [0,1] UV; (−1,−1) = no cursor

      in  vec2 v_uv;
      out vec4 fragColor;

      // ── Noise helpers ────────────────────────────────────────────────────
      float hash21(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 17.5);
        return fract(p.x * p.y);
      }
      float hash11(float p) { return fract(sin(p * 127.1) * 43758.5); }

      float smoothNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash21(i),             hash21(i+vec2(1,0)), u.x),
          mix(hash21(i+vec2(0,1)),   hash21(i+vec2(1,1)), u.x),
          u.y);
      }

      // 4-octave fBm
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * smoothNoise(p);
          p   = p * 2.1 + vec2(1.7, 9.2);
          a  *= 0.5;
        }
        return v;
      }

      // ── Brand palette ────────────────────────────────────────────────────
      const vec3 COL_VIOLET = vec3(0.545, 0.361, 0.965);
      const vec3 COL_GOLD   = vec3(0.839, 0.663, 0.286);
      const vec3 COL_BG     = vec3(0.078, 0.059, 0.149);

      // ── Particle SDF ─────────────────────────────────────────────────────
      // Returns the alpha contribution of one circular particle at centre
      // (cx,cy) with radius r, evaluated at aspect-correct UV coord p.
      float particleAlpha(vec2 p, float cx, float cy, float r) {
        float d = length(p - vec2(cx, cy));
        return 1.0 - smoothstep(r * 0.5, r, d);
      }

      // ── Particle field ───────────────────────────────────────────────────
      // N particles, each with a unique seed-driven position + drift path.
      // Returns (rgb colour, alpha) as a vec4.
      vec4 particles(vec2 p, float aspect) {
        const int   N    = 320;
        const float SPEED = 0.18;

        float accAlpha = 0.0;
        vec3  accCol   = vec3(0.0);

        // Mouse repulsion in aspect-correct space
        vec2 mouseAC = (u_mouse - 0.5) * vec2(aspect, 1.0);
        bool hasMouse = u_mouse.x >= 0.0;

        for (int i = 0; i < N; i++) {
          float fi = float(i);

          // Stable "home" position spread across the full hero
          float hx = (hash11(fi * 1.31) - 0.5) * aspect;
          float hy =  hash11(fi * 2.77) - 0.5;

          // Individual drift: combination of two slow sine oscillators
          float phaseX = hash11(fi * 3.13) * 6.28318;
          float phaseY = hash11(fi * 4.71) * 6.28318;
          float freqX  = 0.3 + hash11(fi * 5.19) * 0.5;
          float freqY  = 0.25 + hash11(fi * 6.37) * 0.45;
          float ampX   = 0.04 + hash11(fi * 7.23) * 0.07;
          float ampY   = 0.03 + hash11(fi * 8.11) * 0.06;

          float cx = hx + sin(u_time * SPEED * freqX + phaseX) * ampX;
          float cy = hy + cos(u_time * SPEED * freqY + phaseY) * ampY;

          // Cursor repulsion — max 0.12 units of deflection, falls off with
          // distance squared so only nearby particles react.
          if (hasMouse) {
            vec2  diff = vec2(cx, cy) - mouseAC;
            float dist = length(diff);
            float str  = smoothstep(0.32, 0.0, dist) * 0.12;
            vec2  push = normalize(diff + vec2(0.0001)) * str;
            cx += push.x;
            cy += push.y;
          }

          // Size: mix between tiny (most) and slightly larger accent dots
          float sizeT = hash11(fi * 9.99);
          float r     = mix(0.002, 0.0065, sizeT * sizeT);

          float a = particleAlpha(p, cx, cy, r);
          if (a < 0.001) continue;

          // Colour: mostly muted violet-white, rare ones lean gold
          float warmth = step(0.88, hash11(fi * 11.3));
          vec3  col    = mix(
            mix(vec3(1.0), COL_VIOLET, 0.45),
            COL_GOLD,
            warmth
          );

          // Brightness falloff: smaller particles dimmer
          float brightness = mix(0.25, 0.85, sizeT);
          accCol  += col * a * brightness;
          accAlpha = max(accAlpha, a * brightness);
        }

        return vec4(accCol, accAlpha);
      }

      // ── Main ─────────────────────────────────────────────────────────────
      void main() {
        float aspect = u_res.x / u_res.y;
        vec2 uv = (v_uv - 0.5) * vec2(aspect, 1.0);

        // ── 1. fBm light-smoke beam ─────────────────────────────────────
        float t  = u_time * 0.07;
        float cx = sin(t * 0.8) * aspect * 0.38;
        float cy = -0.06 + sin(t * 0.55) * 0.06;

        float dx = (uv.x - cx) / (aspect * 0.55);
        float dy = (uv.y - cy) / 0.28;
        float beam = exp(-(dx*dx + dy*dy));

        vec2  smokeUV  = uv * 1.8 + vec2(u_time * 0.025, u_time * 0.012);
        float smoke    = fbm(smokeUV);
        float smoke2   = fbm(smokeUV * 1.4 + vec2(3.7, 1.2));
        float smokeMix = smoke * 0.65 + smoke2 * 0.35;

        float beamMod = beam * (0.72 + smokeMix * 0.44);
        float warmth  = smoothstep(-aspect*0.3, aspect*0.3, cx + smoke*0.3);
        vec3  beamCol = mix(COL_VIOLET, COL_GOLD, warmth * 0.38);

        float ambient = smokeMix * smokeMix * 0.055;
        vec3  ambCol  = mix(COL_VIOLET, COL_BG, 0.55);

        vec3 color = COL_BG
                   + beamCol * beamMod * 0.82
                   + ambCol  * ambient;

        // ── 2. Micro-grain texture ──────────────────────────────────────
        // Fast hash noise at screen-pixel frequency drifting slowly.
        // Very subtle so it doesn't overpower the beam.
        vec2 grainUV = v_uv * u_res * 0.45 + vec2(u_time * 14.0, u_time * 9.3);
        float grain  = hash21(floor(grainUV)) * 2.0 - 1.0;
        color += grain * 0.028;

        // ── 3. Particle field ───────────────────────────────────────────
        vec4 parts = particles(uv, aspect);
        // Additive blend: particles light up on top of the smoke
        color += parts.rgb * parts.a * 1.1;

        // ── Vignette ────────────────────────────────────────────────────
        vec2  vigUV = v_uv * (1.0 - v_uv);
        float vig   = pow(clamp(vigUV.x * vigUV.y * 14.0, 0.0, 1.0), 0.35);
        color      *= vig;

        fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    `;

    // ── Compile & link ───────────────────────────────────────────────────────
    function compile(type: number, src: string) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }
    const vs   = compile(gl.VERTEX_SHADER,   vert);
    const fs   = compile(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime  = gl.getUniformLocation(prog, "u_time");
    const uRes   = gl.getUniformLocation(prog, "u_res");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");

    // Start mouse at "no cursor" sentinel
    let mouseX = -1, mouseY = -1;

    // ── Cursor tracking on nearest <section> ancestor ────────────────────────
    const section = canvas.closest("section") ?? canvas.parentElement;
    const onPointerMove = (e: PointerEvent) => {
      if (!section) return;
      const rect = section.getBoundingClientRect();
      mouseX = (e.clientX - rect.left) / rect.width;
      mouseY = 1.0 - (e.clientY - rect.top)  / rect.height;
    };
    const onPointerLeave = () => { mouseX = -1; mouseY = -1; };

    section?.addEventListener("pointermove",  onPointerMove,  { passive: true });
    section?.addEventListener("pointerleave", onPointerLeave, { passive: true });

    // ── Resize ───────────────────────────────────────────────────────────────
    const DPR = Math.min(window.devicePixelRatio ?? 1, 1.5);
    const resize = () => {
      canvas.width  = canvas.clientWidth  * DPR;
      canvas.height = canvas.clientHeight * DPR;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // ── Render loop ──────────────────────────────────────────────────────────
    let raf = 0;
    let visible = true;

    const render = (t: number) => {
      if (!visible) { raf = 0; return; }
      gl.uniform1f(uTime,  t * 0.001);
      gl.uniform2f(uRes,   canvas.width, canvas.height);
      gl.uniform2f(uMouse, mouseX, mouseY);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(render);
    }, { threshold: 0 });
    io.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      section?.removeEventListener("pointermove",  onPointerMove);
      section?.removeEventListener("pointerleave", onPointerLeave);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    />
  );
}
