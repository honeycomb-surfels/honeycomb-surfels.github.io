import {megabytes} from "./stream.js";

export const patienceMessages = [
    "Good things come to those who wait.",
    "Rome wasn't built in a day.",
    "Patience is a virtue.",
    "Slow and steady wins the race.",
    "A little patience goes a long way.",
    "All in good time.",
];

// The first idiom rolls over soon, so even a load of a few seconds shows the rotation; ROLL_MS matches the CSS.
const FIRST_TURN_MS = 2500;
const TURN_MS = 3500;
const ROLL_MS = 320;

export const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

export class LoadingNotice {
    constructor(root, setStatus) {
        this.root = root;
        this.message = root.querySelector(".loading-message");
        this.stageLabel = root.querySelector(".loading-stage");
        this.bar = root.querySelector(".loading-bar");
        this.fill = root.querySelector(".loading-fill");
        this.bytes = root.querySelector(".loading-bytes");
        this.setStatus = setStatus;
    }

    get active() { return !this.root.hidden; }

    start(stage) {
        this.stop();
        this.root.hidden = false;
        this.index = Math.floor(Math.random() * patienceMessages.length);
        this.message.textContent = patienceMessages[this.index];
        this.progress({fraction: null, done: 0, size: null});
        this.bytes.textContent = "";
        this.stage(stage);
        this.firstTurn = setTimeout(() => {
            this.turn();
            this.interval = setInterval(() => this.turn(), TURN_MS);
        }, FIRST_TURN_MS);
    }

    /** Roll the current idiom up and out, then the next one up from below. */
    turn() {
        this.message.classList.add("rolling-out");
        this.transition = setTimeout(() => {
            this.index = (this.index + 1) % patienceMessages.length;
            this.message.textContent = patienceMessages[this.index];
            this.message.classList.replace("rolling-out", "rolling-in");
            void this.message.offsetWidth; // commit the start position below, so removing the class animates upward
            this.message.classList.remove("rolling-in");
        }, ROLL_MS);
    }

    stage(message) {
        this.stageLabel.textContent = message;
        this.setStatus(message);
    }

    /**
     * Real progress: a bar when the share is known, otherwise an indeterminate bar. The line below shows `note`
     * when given (a decoding step), else the bytes so far.
     */
    progress({fraction, done, size, note = null}) {
        const known = fraction !== null && fraction !== undefined;
        this.bar.classList.toggle("indeterminate", !known);
        this.fill.style.width = known ? `${(fraction * 100).toFixed(1)}%` : "";
        if (known) this.bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
        else this.bar.removeAttribute("aria-valuenow");
        this.bytes.textContent = note ?? (size ? `${megabytes(done)} of ${megabytes(size)}` : done ? megabytes(done) : "");
    }

    stop() {
        clearTimeout(this.firstTurn);
        clearInterval(this.interval);
        clearTimeout(this.transition);
        this.message.classList.remove("rolling-out", "rolling-in");
        this.root.hidden = true;
    }
}
