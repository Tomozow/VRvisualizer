import { App } from '@/app/App';

const container = document.getElementById('app')!;
const overlay = document.getElementById('overlay')!;
const app = new App(container, overlay);

// Expose for debugging / automated tests
(window as unknown as { app: App }).app = app;
