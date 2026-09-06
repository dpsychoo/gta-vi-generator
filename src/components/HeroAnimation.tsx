import { useEffect } from "react";

export default function HeroAnimation() {
  useEffect(() => {
    let lenis: any;
    let isMounted = true;

    const initAnimations = async () => {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);

      if (!isMounted) {
        return;
      }

      gsap.registerPlugin(ScrollTrigger);

      const LenisModule = await import("lenis");
      const Lenis = LenisModule.default || LenisModule;
      lenis = new Lenis({
        duration: 1.2,
        easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smoothWheel: true,
      });

      function raf(time: number) {
        lenis.raf(time);
        requestAnimationFrame(raf);
      }

      requestAnimationFrame(raf);

      gsap.set(".hero-container .text-mask-container", {
        opacity: 0,
      });

      gsap.set(".hero-container .text-background", {
        opacity: 0,
      });

      gsap.set(".hero-container .text-mask", {
        scale: 3.5,
        opacity: 0,
      });

      gsap.set(".hero-container .background-image", {
        scale: 1.5,
      });

      gsap.set(".hero-container .trailer-button-container", {
        opacity: 1,
      });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: ".hero-wrapper",
          start: "top top",
          end: "+=100%",
          scrub: true,
          pin: true,
          pinSpacing: true,
        },
      });

      gsap.set(".hero-container .reveal-text", {
        scale: 1,
        opacity: 1,
      });

      tl.to(
        [".hero-container .reveal-text", ".hero-container .trailer-button-container"],
        {
          opacity: 0,
          duration: 1,
          ease: "power2.inOut",
        },
        ">"
      );

      tl.to(
        ".hero-container .text-mask-container",
        {
          // Keep the legacy black/brand plane hidden until the cinematic takes over.
          opacity: 0,
          duration: 1,
          ease: "power2.inOut",
        },
        ">"
      );

      tl.fromTo(
        ".hero-container .text-mask",
        {
          scale: 3.5,
          opacity: 1,
          y: 0,
        },
        {
          scale: 1,
          opacity: 1,
          y: 0,
          duration: 1.5,
          ease: "power3.out",
        },
        "<"
      );

      tl.to(
        {},
        {
          duration: 0.5,
        },
        ">"
      );

      tl.addLabel("hero-cinematic-handoff");

      tl.to(
        ".hero-container .text-mask",
        {
          scale: 0.25,
          y: "-25vh",
          x: 0,
          duration: 1.2,
          ease: "power2.inOut",
        },
        ">"
      );

      tl.fromTo(
        ".hero-container .background-image",
        {
          opacity: 1,
        },
        {
          opacity: 0,
          duration: 1.2,
          ease: "none",
        },
        "<"
      );

      tl.fromTo(
        ".hero-container .characters-image",
        { opacity: 1 },
        {
          opacity: 0,
          duration: 1.2,
          ease: "none",
        },
        "<"
      );

      tl.set(
        ".hero-container .trailer-button-container",
        {
          opacity: 0,
          display: "none",
        },
        "<"
      );

      tl.set(
        ".hero-container .text-mask",
        {
          opacity: 0,
        },
        "<+1.2"
      );

      tl.to(
        ".hero-container .background-image",
        {
          scale: 1.65,
          duration: 4.2,
          ease: "none",
        },
        0
      );

      const heroWrapper = document.querySelector(".hero-wrapper");
      const handoffStartTime = tl.labels["hero-cinematic-handoff"];
      const handoffDuration = 1.2;
      const syncHeroCinematicHandoff = () => {
        const handoffProgress = Math.min(
          Math.max((tl.time() - handoffStartTime) / handoffDuration, 0),
          1,
        );
        const scrollTrigger = (tl as any).scrollTrigger;
        const scrollStart = Number(scrollTrigger?.start ?? 0);
        const scrollEnd = Number(scrollTrigger?.end ?? window.innerHeight);
        const scrollDistance = Math.max(scrollEnd - scrollStart, 1);
        const handoffStartScrollY =
          scrollStart + (handoffStartTime / Math.max(tl.duration(), 1)) * scrollDistance;

        if (heroWrapper) {
          heroWrapper.dataset.heroCinematicHandoff = String(handoffProgress);
          heroWrapper.dataset.heroCinematicHandoffStart = String(handoffStartScrollY);
          window.dispatchEvent(new Event("hero-cinematic-handoff"));
        }
      };
      tl.eventCallback("onUpdate", syncHeroCinematicHandoff);
      syncHeroCinematicHandoff();

      const hideLoading = () => {
        const overlay = document.getElementById("loading-overlay");
        if (overlay) {
          overlay.style.opacity = "0";
          setTimeout(() => {
            overlay.style.display = "none";
          }, 400);
        }
      };

      window.addEventListener("load", hideLoading);
      setTimeout(hideLoading, 1200);

      return () => {
        isMounted = false;
        ScrollTrigger.getAll().forEach((t: any) => t.kill());
        lenis?.destroy();
        window.removeEventListener("load", hideLoading);
      };
    };

    initAnimations();

    return () => {
      isMounted = false;
    };
  }, []);
}
