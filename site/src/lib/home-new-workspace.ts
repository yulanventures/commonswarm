import { CONTENT_ROLE_COPY, PERSONAL_PURPOSE_WARNING, type HouseholdPurpose } from "./household-access";
import type { ChoiceVM } from "./home-types";

/** One purpose card in the create form; supplied by the integration layer from PURPOSE_COPY. */
export interface PurposeOption {
  value: HouseholdPurpose;
  label: string;
  detail: string;
}

export interface NewWorkspaceVM {
  viewerName: string;
  viewerInitials: string;
  name: string;
  purpose: HouseholdPurpose | null;
  purposes: readonly PurposeOption[];
  busy?: boolean;
  error?: string | null;
}

export interface NewWorkspaceCallbacks {
  onNameInput: (name: string) => void;
  onPurposeSelect: (purpose: HouseholdPurpose) => void;
  onCreate: () => void;
}

/** The purpose choices used by the form; copy comes from the caller's PURPOSE_COPY. */
export function newWorkspacePurposeChoices(vm: NewWorkspaceVM): ChoiceVM<HouseholdPurpose> {
  return {
    name: "create-purpose",
    legend: "Who is it for?",
    value: vm.purpose,
    options: vm.purposes.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.detail,
      disabled: Boolean(vm.busy),
    })),
  };
}

/** Live preview heading (UI-SPEC 3.8). */
export function newWorkspacePreviewTitle(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? `Who'll be in ${trimmed}` : "Who'll be in your workspace";
}

/** The dashed invite slot hides for a personal workspace. */
export function newWorkspaceShowsInviteSlot(purpose: HouseholdPurpose | null): boolean {
  return purpose !== "personal";
}

/** The server refuses a later purpose change; keep that warning on the live form. */
export function newWorkspacePersonalWarning(purpose: HouseholdPurpose | null): string {
  return purpose === "personal" ? PERSONAL_PURPOSE_WARNING : "";
}

/** "Who's in it?" note depends on the chosen purpose (personal workspaces refuse invitations). */
export function newWorkspacePeopleHint(purpose: HouseholdPurpose | null): string {
  if (purpose === "personal") {
    return "Nobody else can be invited to this workspace.";
  }
  return "After you create it, you get an invite link to send yourself, by text or email.";
}

/** Create is allowed only with a non-empty name and a chosen purpose. */
export function newWorkspaceCanCreate(name: string, purpose: HouseholdPurpose | null): boolean {
  return name.trim().length > 0 && (purpose === "shared" || purpose === "personal");
}

const initials = (name: string): string =>
  name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toLocaleUpperCase() || "CS";

/** The canvas draws a person as one letter in a circle (the rail, the people list, the preview). */
const avatarLetter = (vm: NewWorkspaceVM): string =>
  Array.from(vm.viewerInitials || initials(vm.viewerName))[0] ?? "";

/** Pure DOM builder for the new-workspace form and live preview (UI-SPEC 3.8). */
export function buildNewWorkspaceForm(
  doc: Document,
  vm: NewWorkspaceVM,
  callbacks: NewWorkspaceCallbacks,
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "hm-new-workspace";

  const layout = doc.createElement("div");
  layout.className = "hm-new-workspace__layout";

  const formCard = doc.createElement("form");
  formCard.dataset.createForm = "";
  formCard.noValidate = true;
  formCard.addEventListener("submit", event => { event.preventDefault(); callbacks.onCreate(); });
  formCard.className = "hm-new-workspace__card";
  formCard.setAttribute("aria-labelledby", "hm-new-workspace-title");

  const title = doc.createElement("h1");
  title.id = "hm-new-workspace-title";
  title.tabIndex = -1;
  title.dataset.createTitle = "";
  title.className = "hm-new-workspace__title";
  title.textContent = "New workspace";
  root.append(title);

  const nameLabel = doc.createElement("label");
  nameLabel.className = "hm-new-workspace__field";
  const nameLegend = doc.createElement("span");
  nameLegend.className = "hm-new-workspace__label";
  nameLegend.textContent = "Name";
  const nameInput = doc.createElement("input");
  nameInput.type = "text";
  nameInput.id = "dashboard-workspace-name";
  nameInput.name = "workspace-name";
  nameInput.maxLength = 80;
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  nameInput.required = true;
  nameInput.value = vm.name;
  nameInput.disabled = Boolean(vm.busy);
  nameInput.addEventListener("input", () => callbacks.onNameInput(nameInput.value));
  nameLabel.append(nameLegend, nameInput);
  formCard.append(nameLabel);

  const purposeField = doc.createElement("fieldset");
  const purposeChoices = newWorkspacePurposeChoices(vm);
  purposeField.className = "hm-new-workspace__purpose";
  const purposeLegend = doc.createElement("legend");
  purposeLegend.textContent = purposeChoices.legend;
  purposeField.append(purposeLegend);

  const purposeList = doc.createElement("div");
  purposeList.className = "hm-new-workspace__purpose-list";

  for (const option of purposeChoices.options) {
    const card = doc.createElement("label");
    card.className = "hm-new-workspace__purpose-card";
    const input = doc.createElement("input");
    input.type = "radio";
    input.dataset.createPurpose = "";
    input.name = purposeChoices.name;
    input.value = option.value;
    input.checked = purposeChoices.value === option.value;
    input.disabled = Boolean(option.disabled);
    input.addEventListener("change", () => {
      if (input.checked) callbacks.onPurposeSelect(option.value);
    });
    const copy = doc.createElement("span");
    copy.className = "hm-new-workspace__purpose-copy";
    const strong = doc.createElement("strong");
    strong.textContent = option.label;
    const small = doc.createElement("small");
    small.textContent = option.hint ?? "";
    copy.append(strong, small);
    const check = doc.createElement("span");
    check.className = "hm-new-workspace__purpose-check";
    check.setAttribute("aria-hidden", "true"); check.textContent = "✓";
    card.append(input, copy, check);
    purposeList.append(card);
  }
  purposeField.append(purposeList);
  formCard.append(purposeField);

  const personalWarning = doc.createElement("p");
  personalWarning.className = "hm-new-workspace__note-hint";
  personalWarning.dataset.createPersonalWarning = "";
  personalWarning.setAttribute("aria-live", "polite");
  personalWarning.textContent = newWorkspacePersonalWarning(vm.purpose);
  formCard.append(personalWarning);

  const peopleNote = doc.createElement("div");
  peopleNote.className = "hm-new-workspace__note-block";
  const peopleHeading = doc.createElement("h2");
  peopleHeading.className = "hm-new-workspace__note-title";
  peopleHeading.textContent = "Who's in it?";
  const peopleRow = doc.createElement("div");
  peopleRow.className = "hm-new-workspace__person";
  const peopleAvatar = doc.createElement("span");
  peopleAvatar.className = "hm-new-workspace__avatar";
  peopleAvatar.setAttribute("aria-hidden", "true");
  peopleAvatar.textContent = avatarLetter(vm);
  const peopleYou = doc.createElement("p");
  peopleYou.className = "hm-new-workspace__note-line";
  peopleYou.textContent = `You (${vm.viewerName})`;
  peopleRow.append(peopleAvatar, peopleYou);
  const peopleHint = doc.createElement("p");
  peopleHint.className = "hm-new-workspace__note-hint";
  peopleHint.textContent = newWorkspacePeopleHint(vm.purpose);
  peopleNote.append(peopleHeading, peopleRow, peopleHint);
  formCard.append(peopleNote);

  const agentsNote = doc.createElement("div");
  agentsNote.className = "hm-new-workspace__note-block";
  const agentsHeading = doc.createElement("h2");
  agentsHeading.className = "hm-new-workspace__note-title";
  agentsHeading.textContent = "Agents";
  const agentsRow = doc.createElement("div");
  agentsRow.className = "hm-new-workspace__person";
  const agentsSlot = doc.createElement("span");
  agentsSlot.className = "hm-new-workspace__orb hm-new-workspace__orb--dashed";
  agentsSlot.setAttribute("aria-hidden", "true");
  const agentsHint = doc.createElement("p");
  agentsHint.className = "hm-new-workspace__note-hint";
  agentsHint.textContent = "Add agents after you create it, from the apps you use.";
  agentsRow.append(agentsSlot, agentsHint);
  agentsNote.append(agentsHeading, agentsRow);
  formCard.append(agentsNote);

  const create = doc.createElement("button");
  create.type = "submit";
  create.dataset.createButton = "";
  create.className = "hm-new-workspace__create";
  create.textContent = "Create workspace";
  create.disabled = Boolean(vm.busy) || !newWorkspaceCanCreate(vm.name, vm.purpose);

  const footer = doc.createElement("div");
  footer.className = "hm-new-workspace__footer";
  footer.append(create);

  const access = doc.createElement("p"); access.dataset.createAccess = "";
  access.className = "hm-new-workspace__access";
  access.textContent = `Your access: ${CONTENT_ROLE_COPY.editor.label}. You can ${CONTENT_ROLE_COPY.editor.detail.charAt(0).toLowerCase() + CONTENT_ROLE_COPY.editor.detail.slice(1)}`;
  footer.append(access);
  formCard.append(footer);
  {
    const error = doc.createElement("p");
    error.className = "hm-new-workspace__error";
    error.setAttribute("role", "alert");
    error.dataset.createError = "";
    error.textContent = vm.error ?? "";
    error.hidden = !vm.error;
    formCard.append(error);
  }

  const preview = doc.createElement("aside");
  preview.className = "hm-new-workspace__preview";
  preview.setAttribute("aria-live", "polite");

  const previewTitleEl = doc.createElement("h2");
  previewTitleEl.className = "hm-new-workspace__preview-title";
  previewTitleEl.textContent = newWorkspacePreviewTitle(vm.name);
  preview.append(previewTitleEl);

  const previewBox = doc.createElement("div");
  previewBox.className = "hm-new-workspace__preview-box";
  const previewList = doc.createElement("ul");
  previewList.className = "hm-new-workspace__preview-list";
  previewList.setAttribute("role", "list");

  const youItem = doc.createElement("li");
  youItem.className = "hm-new-workspace__preview-you";
  const avatar = doc.createElement("span");
  avatar.className = "hm-new-workspace__avatar";
  avatar.textContent = avatarLetter(vm);
  const youName = doc.createElement("span");
  youName.className = "hm-new-workspace__preview-name";
  const youStrong = doc.createElement("strong");
  youStrong.textContent = vm.viewerName;
  const youSub = doc.createElement("small");
  youSub.textContent = "You";
  youName.append(youStrong, youSub);
  youItem.append(avatar, youName);
  previewList.append(youItem);

  const agentItem = doc.createElement("li");
  agentItem.className = "hm-new-workspace__preview-slot hm-new-workspace__preview-slot--agents";
  const agentOrb = doc.createElement("span");
  agentOrb.className = "hm-new-workspace__orb hm-new-workspace__orb--dashed";
  agentOrb.setAttribute("aria-hidden", "true");
  const agentLabel = doc.createElement("span");
  agentLabel.textContent = "Agents you add";
  agentItem.append(agentOrb, agentLabel);
  previewList.append(agentItem);

  if (newWorkspaceShowsInviteSlot(vm.purpose)) {
    const inviteItem = doc.createElement("li");
    inviteItem.className = "hm-new-workspace__preview-slot hm-new-workspace__preview-slot--people";
    const inviteAvatar = doc.createElement("span");
    inviteAvatar.className = "hm-new-workspace__avatar hm-new-workspace__avatar--dashed";
    inviteAvatar.setAttribute("aria-hidden", "true");
    const inviteLabel = doc.createElement("span");
    inviteLabel.textContent = "People you invite";
    inviteItem.append(inviteAvatar, inviteLabel);
    previewList.append(inviteItem);
  }

  previewBox.append(previewList);
  preview.append(previewBox);
  layout.append(formCard, preview);
  root.append(layout);
  return root;
}
