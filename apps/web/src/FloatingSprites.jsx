/**
 * FloatingSprites — bomb & gem pixel art sprites floating around the screen.
 * Bounces off viewport boundaries. Low opacity, behind all content.
 */
import { useEffect, useRef } from 'react';
import bombSprite from './assets/pixel/bomb-v1.png';
import gemSprite from './assets/pixel/gem-v1.png';

export default function FloatingSprites() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

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
      { img: () => bombImg, size: 28, weight: 1 },
      { img: () => gemImg, size: 24, weight: 1 },
    ];

    let sprites = [];

    function initSprites() {
      const count = window.innerWidth < 768 ? 15 : 27;
      sprites = [];
      for (let i = 0; i < count; i++) {
        const type = SPRITE_TYPES[i % SPRITE_TYPES.length];
        sprites.push({
          x: Math.random() * (canvas.width - type.size),
          y: Math.random() * (canvas.height - type.size),
          vx: (Math.random() - 0.5) * 0.6,
          vy: (Math.random() - 0.5) * 0.6,
          size: type.size + Math.random() * 12,
          rotation: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.015,
          img: type.img,
          opacity: 0.04 + Math.random() * 0.05,
        });
      }
    }

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initSprites();
    }
    resize();
    window.addEventListener('resize', resize);

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
      window.removeEventListener('resize', resize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        imageRendering: 'pixelated',
      }}
    />
  );
}
