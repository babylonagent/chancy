/**
 * FloatingSprites — bomb & gem pixel art sprites floating around the screen.
 * Bounces off viewport boundaries AND each other. Behind all content.
 */
import { useEffect, useRef } from 'react';
import bombSprite from './assets/pixel/bomb-v1.png';
import gemSprite from './assets/pixel/gem-v1.png';

export default function FloatingSprites() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const scrollYRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Load sprite images
    const bombImg = new Image();
    bombImg.src = bombSprite;
    const gemImg = new Image();
    gemImg.src = gemSprite;

    let imgsLoaded = 0;
    const onImgLoad = () => { imgsLoaded++; };
    bombImg.onload = onImgLoad;
    gemImg.onload = onImgLoad;

    // Sprite configuration
    const SPRITE_TYPES = [
      { img: () => bombImg, size: 28 },
      { img: () => gemImg, size: 24 },
    ];

    let sprites = [];

    function initSprites() {
      const isMobile = window.innerWidth < 768;
      const count = isMobile ? 15 : 27;
      const speed = isMobile ? 0.18 : 0.25;
      sprites = [];
      for (let i = 0; i < count; i++) {
        const type = SPRITE_TYPES[i % SPRITE_TYPES.length];
        sprites.push({
          x: Math.random() * (canvas.width - type.size),
          y: Math.random() * (canvas.height - type.size),
          vx: (Math.random() - 0.5) * speed,
          vy: (Math.random() - 0.5) * speed,
          size: type.size + Math.random() * 12,
          rotation: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.008,
          img: type.img,
          opacity: 0.75,
        });
      }
    }

    let lastWidth = 0;

    function resize() {
      const newWidth = window.innerWidth;
      canvas.width = newWidth;
      canvas.height = window.innerHeight;
      // Only re-seed sprites on real width changes (orientation/desktop resize).
      // Mobile address bar show/hide changes height only — don't re-seed on that.
      if (newWidth !== lastWidth) {
        lastWidth = newWidth;
        initSprites();
      }
    }
    resize();
    // Debounce — mobile fires dozens of resize events during address bar transitions
    let resizeTimer;
    const debouncedResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    };
    window.addEventListener('resize', debouncedResize);

    // --- Sprite-sprite elastic collision ---
    function resolveCollisions() {
      for (let i = 0; i < sprites.length; i++) {
        for (let j = i + 1; j < sprites.length; j++) {
          const a = sprites[i];
          const b = sprites[j];
          const ax = a.x + a.size / 2;
          const ay = a.y + a.size / 2;
          const bx = b.x + b.size / 2;
          const by = b.y + b.size / 2;
          const dx = bx - ax;
          const dy = by - ay;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = (a.size + b.size) / 2;

          if (dist < minDist && dist > 0) {
            // Normalize collision vector
            const nx = dx / dist;
            const ny = dy / dist;

            // Separate overlap
            const overlap = minDist - dist;
            a.x -= nx * overlap / 2;
            a.y -= ny * overlap / 2;
            b.x += nx * overlap / 2;
            b.y += ny * overlap / 2;

            // Relative velocity along normal
            const dvx = b.vx - a.vx;
            const dvy = b.vy - a.vy;
            const dvn = dvx * nx + dvy * ny;

            // Only resolve if moving toward each other
            if (dvn < 0) {
              // Equal mass elastic collision — swap normal velocity components
              a.vx += dvn * nx;
              a.vy += dvn * ny;
              b.vx -= dvn * nx;
              b.vy -= dvn * ny;
            }
          }
        }
      }
    }

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const s of sprites) {
        // Move
        s.x += s.vx;
        s.y += s.vy;
        s.rotation += s.rotSpeed;

        // Bounce off walls
        if (s.x <= 0) { s.x = 0; s.vx = Math.abs(s.vx); }
        if (s.x + s.size >= canvas.width) { s.x = canvas.width - s.size; s.vx = -Math.abs(s.vx); }
        if (s.y <= 0) { s.y = 0; s.vy = Math.abs(s.vy); }
        if (s.y + s.size >= canvas.height) { s.y = canvas.height - s.size; s.vy = -Math.abs(s.vy); }
      }

      // Sprite-to-sprite collisions
      resolveCollisions();

      for (const s of sprites) {
        // Draw with rotation
        ctx.save();
        ctx.globalAlpha = s.opacity;
        ctx.translate(s.x + s.size / 2, s.y + s.size / 2);
        ctx.rotate(s.rotation);
        const img = s.img();
        if (img.complete && img.naturalWidth > 0) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, -s.size / 2, -s.size / 2, s.size, s.size);
        }
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(animate);
    }

    // Start animation (images will pop in when loaded)
    animate();

    return () => {
      window.removeEventListener('resize', debouncedResize);
      clearTimeout(resizeTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: -1,
        pointerEvents: 'none',
        imageRendering: 'pixelated',
      }}
    />
  );
}
