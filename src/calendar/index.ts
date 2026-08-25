import { Calendar, type EventInput } from "@fullcalendar/core";
import ukLocale from "@fullcalendar/core/locales/uk";
import dayGridPlugin from "@fullcalendar/daygrid";
import { invoke } from "@tauri-apps/api/core";

interface CalendarEvent {
  id: string;
  path: string;
  title: string;
  start: string;
  color: string;
  textColor: string;
  urgent: boolean;
}

interface CalendarCallbacks {
  onOpenProfile: (relativePath: string) => void;
}

let calendar: Calendar | null = null;
let calendarResizeObserver: ResizeObserver | null = null;

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Сталася невідома помилка.";
}

export function destroyCalendar(): void {
  calendarResizeObserver?.disconnect();
  calendarResizeObserver = null;
  calendar?.destroy();
  calendar = null;
}

export function resizeCalendar(): void {
  if (!calendar) return;
  requestAnimationFrame(() => {
    calendar?.updateSize();
  });
}

export function scheduleCalendarResize(): void {
  resizeCalendar();
  window.setTimeout(resizeCalendar, 160);
  window.setTimeout(resizeCalendar, 320);
}

export async function renderCalendarPage(root: HTMLElement, callbacks: CalendarCallbacks): Promise<void> {
  destroyCalendar();
  root.innerHTML = `
    <div class="app-content-header">
      <div class="container-fluid">
        <div class="content-heading">
          <div><h1 class="mb-1">Календар</h1></div>
        </div>
      </div>
    </div>
    <div class="app-content calendar-page">
      <div class="container-fluid">
        <section class="card calendar-card">
          <div class="card-body">
            <div id="calendar-loading" class="calendar-loading" role="status">
              <span class="spinner-border spinner-border-sm text-primary" aria-hidden="true"></span>
              <span>Завантажуємо події…</span>
            </div>
            <div id="calendar-alert" class="alert alert-danger d-none" role="alert"></div>
            <div id="calendar"></div>
          </div>
        </section>
      </div>
    </div>`;

  const calendarElement = root.querySelector<HTMLElement>("#calendar");
  const loading = root.querySelector<HTMLElement>("#calendar-loading");
  const alert = root.querySelector<HTMLElement>("#calendar-alert");
  if (!calendarElement) return;

  try {
    const records = await invoke<CalendarEvent[]>("get_calendar_events");
    if (!calendarElement.isConnected) return;
    const events: EventInput[] = records.map((event) => ({
      id: event.id,
      title: event.title,
      start: event.start,
      allDay: true,
      backgroundColor: event.color,
      borderColor: event.color,
      textColor: event.textColor,
      extendedProps: {
        path: event.path,
        urgent: event.urgent,
      },
    }));

    calendar = new Calendar(calendarElement, {
      plugins: [dayGridPlugin],
      initialView: "dayGridMonth",
      locale: ukLocale,
      firstDay: 1,
      height: "auto",
      dayMaxEvents: true,
      customButtons: {
        calendarPrev: {
          text: "",
          hint: "Попередній місяць",
          click: () => calendar?.prev(),
        },
        calendarNext: {
          text: "",
          hint: "Наступний місяць",
          click: () => calendar?.next(),
        },
      },
      headerToolbar: {
        left: "calendarPrev,calendarNext today",
        center: "title",
        right: "",
      },
      events,
      eventClick: (argument) => {
        const path = String(argument.event.extendedProps.path ?? "");
        if (path) callbacks.onOpenProfile(path);
      },
      eventContent: (argument) => {
        const content = document.createElement("span");
        content.className = "calendar-event-content";
        if (argument.event.extendedProps.urgent === true) {
          const icon = document.createElement("span");
          icon.className = "calendar-event-status";
          icon.setAttribute("aria-label", "На виконанні");
          icon.textContent = "!";
          content.append(icon);
        }
        const title = document.createElement("span");
        title.textContent = argument.event.title;
        content.append(title);
        return { domNodes: [content] };
      },
    });
    calendar.render();
    calendarResizeObserver = new ResizeObserver(scheduleCalendarResize);
    calendarResizeObserver.observe(calendarElement);
    const appMain = calendarElement.closest<HTMLElement>(".app-main");
    if (appMain) calendarResizeObserver.observe(appMain);
  } catch (error) {
    if (alert) {
      alert.textContent = errorMessage(error);
      alert.classList.remove("d-none");
    }
  } finally {
    loading?.remove();
  }
}
