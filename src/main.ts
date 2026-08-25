import "bootstrap/dist/css/bootstrap.min.css";
import "admin-lte/dist/css/adminlte.min.css";
import "datatables.net-bs5/css/dataTables.bootstrap5.min.css";
import "./styles.css";
import "./profile/styles.css";
import "./catalogue/styles.css";
import "./calendar/styles.css";

import "bootstrap";
import "admin-lte/dist/js/adminlte.min.js";
import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { icon } from "./icons";
import { renderEmptyProfilePage, renderProfilePage, type InnerFile } from "./profile";
import { destroyCatalogueTable, renderCataloguePage, type DirectoryEntry } from "./catalogue";
import { destroyCalendar, renderCalendarPage, scheduleCalendarResize } from "./calendar";

interface ProjectInfo {
  name: string;
  path: string;
  directories: DirectoryEntry[];
  databasePath: string;
}

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Не вдалося знайти кореневий елемент застосунку.");
}

const app: HTMLDivElement = appElement;
let currentProject: ProjectInfo | null = null;
let pendingRename: {
  relativePath: string;
  currentName: string;
  returnToProfile: boolean;
  focusTarget?: HTMLElement;
} | null = null;
let profileHost: HTMLDivElement | null = null;
let preservedCatalogueNodes: HTMLElement[] = [];

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character] ?? character,
  );
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Сталася невідома помилка.";
}

function renderLoading(): void {
  app.innerHTML = `
    <main class="launch-screen">
      <section class="launch-card launch-card--loading" aria-label="Завантаження проєкту">
        <div class="brand-mark">${icon("archive", "brand-mark__icon")}</div>
        <div class="spinner-border spinner-border-sm text-primary" role="status">
          <span class="visually-hidden">Завантаження…</span>
        </div>
        <p class="mb-0 text-secondary">Відновлюємо робочу сесію…</p>
      </section>
    </main>`;
}

function renderWelcome(error?: string): void {
  app.innerHTML = `
    <main class="launch-screen">
      <section class="launch-card">
        <div class="brand-mark">${icon("archive", "brand-mark__icon")}</div>
        <p class="eyebrow">ASCOD Project Manager</p>
        <h1>Відкрийте робочий каталог</h1>
        <p class="launch-description">
          Виберіть локальну папку. Застосунок створить у ній службовий каталог
          <code>.project</code> і збереже локальну базу даних.
        </p>
        ${
          error
            ? `<div class="alert alert-danger text-start" role="alert">${escapeHtml(error)}</div>`
            : ""
        }
        <button id="open-project" class="btn btn-primary btn-lg open-project-button" type="button">
          ${icon("folder")}<span>Вибрати каталог</span>
        </button>
        <p class="privacy-note">Усі дані залишаються на вашому комп’ютері</p>
      </section>
    </main>`;

  document.querySelector<HTMLButtonElement>("#open-project")?.addEventListener("click", selectProject);
}

function renderProject(project: ProjectInfo): void {
  currentProject = project;
  profileHost = null;
  preservedCatalogueNodes = [];
  destroyCatalogueTable();
  destroyCalendar();

  app.innerHTML = `
    <div class="app-wrapper">
      <nav id="main-nav-top-menu" class="app-header navbar navbar-expand bg-white border-bottom">
        <div class="container-fluid">
          <ul class="navbar-nav">
            <li class="nav-item">
              <button class="nav-link icon-button" data-lte-toggle="sidebar" type="button" aria-label="Перемкнути бічну панель">
                ${icon("menu")}
              </button>
            </li>
          </ul>
          <div class="header-project">
            <span class="header-project__status"></span>
            <span>${escapeHtml(project.name)}</span>
          </div>
        </div>
      </nav>

      <aside class="app-sidebar bg-dark shadow" data-bs-theme="dark">
        <div class="sidebar-brand">
          <span class="brand-link">
            <span class="sidebar-logo">${icon("archive", "sidebar-logo__icon")}</span>
            <span class="brand-text fw-semibold">ASCOD</span>
          </span>
        </div>
        <div class="sidebar-wrapper">
          <nav class="mt-3">
            <ul class="nav sidebar-menu flex-column" role="menu">
              <li class="nav-header">РОБОЧИЙ ПРОСТІР</li>
              <li class="nav-item">
                <button id="open-calendar" class="nav-link w-100 border-0 text-start" type="button">
                  ${icon("calendar", "nav-icon")}
                  <p>Календар</p>
                </button>
              </li>
              <li class="nav-item">
                <button id="open-directories" class="nav-link active w-100 border-0 text-start" type="button">
                  ${icon("grid", "nav-icon")}
                  <p>Каталоги</p>
                </button>
              </li>
              <li class="nav-item mt-2">
                <button id="change-project" class="nav-link w-100 border-0 bg-transparent text-start" type="button">
                  ${icon("folder", "nav-icon")}
                  <p>Змінити проєкт</p>
                </button>
              </li>
              <li class="nav-item">
                <button id="open-profile" class="nav-link w-100 border-0 bg-transparent text-start" type="button">
                  ${icon("folder", "nav-icon")}
                  <p>Тека</p>
                </button>
              </li>
            </ul>
          </nav>
          <div class="sidebar-footer-project">
            <span class="sidebar-version">v0.2.0</span>
          </div>
        </div>
      </aside>

      <main class="app-main">
        <div class="app-content-header">
          <div class="container-fluid">
            <div class="content-heading">
              <div>
                <h1 class="mb-1">Каталоги</h1>
              </div>
              <button id="refresh-project" class="btn btn-outline-primary" type="button">
                ${icon("refresh")}<span>Оновити</span>
              </button>
            </div>
          </div>
        </div>
        <div class="app-content">
          <div class="container-fluid">
            <div id="project-alert" class="alert d-none" role="alert"></div>
            <div id="catalogue-root"></div>
          </div>
        </div>
      </main>
      <div id="rename-modal" class="rename-modal" hidden>
        <div class="rename-modal__backdrop" data-rename-cancel></div>
        <section class="rename-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="rename-modal-title">
          <form id="rename-form">
            <div class="rename-modal__header">
              <h2 id="rename-modal-title">Перейменувати каталог</h2>
              <button class="rename-modal__close" type="button" aria-label="Закрити" data-rename-cancel>&times;</button>
            </div>
            <label class="form-label" for="rename-input">Нова назва</label>
            <input id="rename-input" class="form-control" type="text" autocomplete="off" required />
            <div class="rename-modal__actions">
              <button class="btn btn-light" type="button" data-rename-cancel>Скасувати</button>
              <button id="rename-submit" class="btn btn-primary" type="submit">Зберегти</button>
            </div>
          </form>
        </section>
      </div>
    </div>`;

  const catalogueRoot = document.querySelector<HTMLElement>("#catalogue-root");
  if (catalogueRoot) {
    renderCataloguePage(catalogueRoot, project.directories, {
      onOpenFolder: (relativePath, name) => void openFolder(relativePath, name, { preserveCatalogue: true }),
    });
  }

  document.querySelector<HTMLButtonElement>("#refresh-project")?.addEventListener("click", refreshProject);
  document.querySelector<HTMLButtonElement>("#change-project")?.addEventListener("click", changeProject);
  document.querySelector<HTMLButtonElement>("#open-directories")?.addEventListener("click", showDirectories);
  document.querySelector<HTMLButtonElement>("#open-calendar")?.addEventListener("click", () => {
    void openCalendar();
  });
  document.querySelector<HTMLButtonElement>("#open-profile")?.addEventListener("click", openProfile);
  document.querySelector<HTMLFormElement>("#rename-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitRename();
  });
  document.querySelectorAll<HTMLElement>("[data-rename-cancel]").forEach((element) => {
    element.addEventListener("click", closeRenameModal);
  });
  document.querySelector<HTMLElement>('[data-lte-toggle="sidebar"]')?.addEventListener("click", scheduleCalendarResize);
  document.querySelector<HTMLElement>(".app-sidebar")?.addEventListener("opened.lte.push-menu", scheduleCalendarResize);
  document.querySelector<HTMLElement>(".app-sidebar")?.addEventListener("collapsed.lte.push-menu", scheduleCalendarResize);
}

function openProfile(): void {
  destroyCatalogueTable();
  destroyCalendar();
  profileHost = null;
  preservedCatalogueNodes = [];
  const appMain = document.querySelector<HTMLElement>(".app-main");
  if (!appMain) return;

  renderEmptyProfilePage(appMain);
  document.querySelector<HTMLButtonElement>("#open-directories")?.classList.remove("active");
  document.querySelector<HTMLButtonElement>("#open-calendar")?.classList.remove("active");
  document.querySelector<HTMLButtonElement>("#open-profile")?.classList.add("active");
}

function setNavigation(active: "calendar" | "directories" | "profile"): void {
  document.querySelector<HTMLButtonElement>("#open-directories")?.classList.toggle("active", active === "directories");
  document.querySelector<HTMLButtonElement>("#open-calendar")?.classList.toggle("active", active === "calendar");
  document.querySelector<HTMLButtonElement>("#open-profile")?.classList.toggle("active", active === "profile");
}

function removeProfileHost(): void {
  profileHost?.remove();
  profileHost = null;
}

function showDirectories(): void {
  destroyCalendar();
  removeProfileHost();

  if (preservedCatalogueNodes.length) {
    preservedCatalogueNodes.forEach((node) => {
      node.hidden = false;
    });
    preservedCatalogueNodes = [];
    setNavigation("directories");
    return;
  }

  if (document.querySelector("#catalogue-root")) {
    setNavigation("directories");
    return;
  }

  if (currentProject) renderProject(currentProject);
}

function prepareProfileHost(appMain: HTMLElement, preserveCatalogue: boolean): HTMLElement {
  removeProfileHost();

  if (preserveCatalogue && appMain.querySelector("#catalogue-root")) {
    preservedCatalogueNodes = Array.from(appMain.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    preservedCatalogueNodes.forEach((node) => {
      node.hidden = true;
    });
  } else {
    preservedCatalogueNodes = [];
    destroyCatalogueTable();
    destroyCalendar();
    appMain.innerHTML = "";
  }

  profileHost = document.createElement("div");
  appMain.append(profileHost);
  return profileHost;
}

async function openCalendar(): Promise<void> {
  destroyCatalogueTable();
  removeProfileHost();
  preservedCatalogueNodes = [];
  const appMain = document.querySelector<HTMLElement>(".app-main");
  if (!appMain) return;

  setNavigation("calendar");
  await renderCalendarPage(appMain, {
    onOpenProfile: (relativePath) => void openFolder(relativePath, relativePath),
  });
}

async function openFolder(
  relativePath: string,
  name: string,
  options: { preserveCatalogue?: boolean } = {},
): Promise<void> {
  const appMain = document.querySelector<HTMLElement>(".app-main");
  if (!appMain) return;

  try {
    const files = await invoke<InnerFile[]>("get_folder_files", { relativePath });
    const host = prepareProfileHost(appMain, options.preserveCatalogue === true);
    renderProfilePage(host, name, relativePath, files, {
      onBack: showDirectories,
      onRefresh: () => void openFolder(relativePath, name, { preserveCatalogue: preservedCatalogueNodes.length > 0 }),
      onRename: () =>
        startRename(relativePath, name, {
          returnToProfile: true,
          focusTarget: host.querySelector<HTMLButtonElement>("#profile-rename-folder") ?? undefined,
        }),
    });
    setNavigation("profile");
  } catch (error) {
    await message(errorMessage(error), {
      title: "Не вдалося відкрити теку",
      kind: "error",
    });
  }
}

function setBusy(button: HTMLButtonElement | null, busy: boolean, label: string): void {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.originalContent = button.innerHTML;
    button.innerHTML = `<span class="spinner-border spinner-border-sm" aria-hidden="true"></span><span>${label}</span>`;
  } else if (button.dataset.originalContent) {
    button.innerHTML = button.dataset.originalContent;
  }
}

function showProjectAlert(message: string, type: "success" | "danger"): void {
  const alert = document.querySelector<HTMLDivElement>("#project-alert");
  if (!alert) return;
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
}

async function selectProject(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#open-project");
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Виберіть робочий каталог",
    });
    if (!selected) return;

    setBusy(button, true, "Відкриваємо…");
    const project = await invoke<ProjectInfo>("open_project", { path: selected });
    renderProject(project);
  } catch (error) {
    renderWelcome(errorMessage(error));
  } finally {
    setBusy(button, false, "Відкрити");
  }
}

async function refreshProject(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#refresh-project");
  try {
    setBusy(button, true, "Скануємо…");
    const project = await invoke<ProjectInfo>("refresh_project");
    renderProject(project);
  } catch (error) {
    showProjectAlert(errorMessage(error), "danger");
  } finally {
    setBusy(button, false, "Оновити");
  }
}

async function changeProject(): Promise<void> {
  try {
    await invoke("close_project");
    renderWelcome();
  } catch (error) {
    showProjectAlert(errorMessage(error), "danger");
  }
}

function startRename(
  relativePath: string,
  currentName: string,
  options: { returnToProfile?: boolean; focusTarget?: HTMLElement } = {},
): void {
  if (!relativePath || !currentName) return;

  pendingRename = {
    relativePath,
    currentName,
    returnToProfile: options.returnToProfile === true,
    focusTarget: options.focusTarget,
  };
  const modal = document.querySelector<HTMLDivElement>("#rename-modal");
  const input = document.querySelector<HTMLInputElement>("#rename-input");
  if (!modal || !input) return;
  input.value = currentName;
  modal.hidden = false;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeRenameModal(): void {
  const modal = document.querySelector<HTMLDivElement>("#rename-modal");
  if (modal) modal.hidden = true;
  pendingRename = null;
}

async function submitRename(): Promise<void> {
  if (!pendingRename) return;
  const { relativePath, currentName, returnToProfile, focusTarget } = pendingRename;
  const input = document.querySelector<HTMLInputElement>("#rename-input");
  const submitButton = document.querySelector<HTMLButtonElement>("#rename-submit");
  const nextName = input?.value.trim();
  if (!nextName || nextName === currentName) {
    closeRenameModal();
    return;
  }

  try {
    setBusy(submitButton, true, "Зберігаємо…");
    const project = await invoke<ProjectInfo>("rename_directory", {
      relativePath,
      newName: nextName,
    });
    closeRenameModal();
    renderProject(project);
    if (returnToProfile) {
      await openFolder(nextName, nextName);
    }
  } catch (error) {
    await message(errorMessage(error), {
      title: "Не вдалося перейменувати каталог",
      kind: "error",
    });
  } finally {
    setBusy(submitButton, false, "Зберегти");
    if (focusTarget?.isConnected) focusTarget.focus();
  }
}

async function initialize(): Promise<void> {
  renderLoading();
  try {
    const project = await invoke<ProjectInfo | null>("get_current_project");
    if (project) renderProject(project);
    else renderWelcome();
  } catch (error) {
    renderWelcome(errorMessage(error));
  }
}

void initialize();
