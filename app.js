import {
  createClient,
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";
import QRCode from "qrcode";

const PAYMENT_BUCKET = "ideaforge-payment-proofs";
const INITIAL_MEMBER_COUNT = 2;
const MAX_MEMBER_COUNT = 5;
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase =
  supabaseUrl && supabaseAnonKey && !supabaseAnonKey.startsWith("your-")
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

const publicView = document.querySelector("#public-view");
const adminView = document.querySelector("#admin-view");
const profilePage = document.querySelector("#profile, #profile-page");
const teamForm = document.querySelector("#team-form");
const paymentForm = document.querySelector("#payment-form");
const successPanel = document.querySelector("#registration-success");
const membersList = document.querySelector("#members-list");
const toast = document.querySelector("#toast");
const adminToast = document.querySelector("#admin-toast");

let draftTeam = null;
let memberCount = INITIAL_MEMBER_COUNT;
let selectedScreenshot = null;
let toastTimer;
let participantUser = null;
let participantAuthReady = !supabase;
let adminEmailsData = [];
let activeEmailFilter = "all";
let activeParticipantTeam = null;
let participantTeamStatus = "checking";
let participantCheckinScannerControls = null;
let participantCheckinEnabled = false;
let adminCheckinEnabled = false;
let adminTeamsData = [];

function updateRegistrationLinks() {
  const isRegistered = participantTeamStatus === "registered";
  const isIncomplete = participantTeamStatus === "incomplete";
  const registrationLink = document.querySelector("#registration-nav-link");
  registrationLink.href = isRegistered || isIncomplete ? "#profile" : "#register";
  registrationLink.textContent = isRegistered
    ? "View registration"
    : isIncomplete
      ? "Finish registration"
      : "Register";
  const heroLink = document.querySelector("#hero-registration-link");
  if (heroLink) {
    heroLink.href = isRegistered || isIncomplete ? "#profile" : "#register";
    heroLink.textContent = isRegistered
      ? "You’ve already registered — view your profile"
      : isIncomplete
        ? "Complete your registration"
        : "Register your team";
  }
  const profileLink = document.querySelector("#profile-nav-link");
  profileLink.textContent = participantUser ? "My profile" : "Sign in / Profile";
}

function clearOAuthTokensFromUrl() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has("access_token") && !fragment.has("refresh_token")) return;

  const participantIntent = sessionStorage.getItem("ideaforge_participant_intent");
  const targetHash = participantIntent === "register" ? "#register" : "#profile";
  window.history.replaceState(
    window.history.state,
    document.title,
    `${window.location.pathname}${window.location.search}${targetHash}`,
  );
}

function updateParticipantProfile(user) {
  participantUser = user;
  activeParticipantTeam = null;
  draftTeam = null;
  const profileLink = document.querySelector("#profile-nav-link");
  const signedOutPanel = document.querySelector("#profile-signed-out");
  const signedInPanel = document.querySelector("#profile-signed-in");
  const teamCard = document.querySelector("#profile-team-card");
  const paymentCard = document.querySelector("#profile-payment-card");
  const teamMessage = document.querySelector("#profile-team-message");
  const registerLink = document.querySelector("#profile-register-link");
  registerLink.innerHTML = "Register your team <span>↗</span>";

  participantTeamStatus = user ? "checking" : "none";
  profileLink.textContent = user ? "My profile" : "Sign in / Profile";
  signedOutPanel.hidden = Boolean(user);
  signedInPanel.hidden = !user;
  teamCard.hidden = true;
  paymentCard.hidden = true;
  teamMessage.textContent = "";
  registerLink.hidden = false;
  document.querySelector("#participant-checkin-message").textContent = "";
  document.querySelector(".profile-team-qr-card").hidden = true;
  participantCheckinEnabled = false;
  stopParticipantCheckinScanner();
  updateRegistrationLinks();
  const teamContactEmail = document.querySelector("#member-0-email");
  if (teamContactEmail) {
    teamContactEmail.value = user?.email ?? "";
    teamContactEmail.readOnly = Boolean(user?.email);
  }
  if (!user) {
    successPanel.hidden = true;
    return;
  }

  const metadata = user.user_metadata ?? {};
  document.querySelector("#profile-name").textContent =
    metadata.full_name ?? metadata.name ?? user.email ?? "IdeaForge participant";
  document.querySelector("#profile-email").textContent = user.email ?? "";
  void loadParticipantTeam(user.id);
}

async function loadParticipantTeam(userId) {
  const teamCard = document.querySelector("#profile-team-card");
  const paymentCard = document.querySelector("#profile-payment-card");
  const teamMessage = document.querySelector("#profile-team-message");
  const registerLink = document.querySelector("#profile-register-link");
  const reuploadForm = document.querySelector("#profile-payment-resubmit");
  if (!supabase || !participantUser || participantUser.id !== userId) return;

  participantTeamStatus = "checking";
  updateRegistrationLinks();
  teamMessage.textContent = "Checking for your team…";
  teamCard.hidden = true;
  paymentCard.hidden = true;
  reuploadForm.hidden = true;
  document.querySelector("#profile-payment-edit-notice").hidden = true;
  document.querySelector("#profile-payment-utr-input").value = "";
  document.querySelector(".profile-team-qr-card").hidden = true;
  const { data, error } = await supabase.rpc("ideaforge_get_my_team");
  if (participantUser?.id !== userId) return;
  if (error) {
    console.error("Could not load the participant's IdeaForge team.", error);
    participantTeamStatus = "error";
    updateRegistrationLinks();
    teamMessage.textContent = "Your team profile is temporarily unavailable. Please reload and try again.";
    refreshRegistrationState();
    return;
  }

  const team = data;
  activeParticipantTeam = team;
  if (!team) {
    participantTeamStatus = "none";
    updateRegistrationLinks();
    teamMessage.textContent = "No team is registered with this Google account yet.";
    refreshRegistrationState();
    return;
  }

  const paymentSubmitted = team.payment_status !== "awaiting_payment";
  participantTeamStatus = paymentSubmitted ? "registered" : "incomplete";
  updateRegistrationLinks();
  document.querySelector("#profile-team-code").textContent =
    paymentSubmitted ? team.team_code || "—" : "Issued after payment submission";
  const profileRegType = document.querySelector("#profile-registration-type");
  if (profileRegType) {
    profileRegType.textContent = team.registration_type === "internal" ? "Internal · Free" : "External";
  }
  document.querySelector("#profile-team-registered").textContent =
    team.created_at ? new Date(team.created_at).toLocaleString() : "—";
  if (!paymentSubmitted && team.is_team_contact) {
    draftTeam = {
      id: team.team_id,
      teamName: team.team_name,
      members: (team.members ?? []).map((member) => ({
        name: member.full_name,
        college: member.college_name,
        mobile: member.mobile_number,
        email: member.email,
      })),
      createdAt: team.created_at,
    };
    document.querySelector("#payment-team-summary").textContent =
      `${draftTeam.teamName} · ${draftTeam.members.length} members · Team contact: ${draftTeam.members[0]?.name ?? "Team leader"}`;
    const paymentAmountEl = document.querySelector("#payment-amount");
    if (paymentAmountEl) {
      paymentAmountEl.textContent = `₹${draftTeam.members.length * 99}`;
    }
  } else {
    draftTeam = null;
  }

  const { data: checkinSetting, error: checkinSettingError } = await supabase
    .from("ideaforge_settings")
    .select("participant_checkin_enabled")
    .eq("id", true)
    .single();
  if (participantUser?.id !== userId) return;
  if (checkinSettingError) {
    console.error("Could not read the participant check-in setting.", checkinSettingError);
    participantCheckinEnabled = false;
    document.querySelector("#participant-checkin-message").textContent =
      "Check-in scanning is currently unavailable. Please contact an organizer.";
  } else {
    participantCheckinEnabled = checkinSetting?.participant_checkin_enabled === true;
  }
  document.querySelector(".profile-team-qr-card").hidden =
    !participantCheckinEnabled || !paymentSubmitted;

  document.querySelector("#profile-team-name").textContent = team.team_name;
  document.querySelector("#profile-team-checkin").textContent = team.checked_in_at
    ? `Checked in at ${new Date(team.checked_in_at).toLocaleString()}`
    : "Not checked in";
  document.querySelector("#profile-note").textContent = team.payment_status === "not_required"
    ? "Your internal registration is confirmed. No payment is required."
    : team.payment_status === "awaiting_payment"
      ? team.is_team_contact
        ? "Your team details are saved, but registration is incomplete. Submit the UTR and payment screenshot below to complete registration."
        : "Your team details are saved, but registration is incomplete until the team leader submits the UTR and payment screenshot."
      : team.payment_status === "pending_review"
        ? "Your registration is saved. Payment proof is waiting for admin review."
        : team.payment_status === "approved"
          ? "Your registration is confirmed. Your team check-in status is shown below."
          : "Your registration and payment need attention. Check the details below.";

  const memberList = document.querySelector("#profile-team-members");
  memberList.replaceChildren();
  for (const member of team.members ?? []) {
    const row = document.createElement("div");
    row.className = "profile-member";
    const name = document.createElement("strong");
    name.textContent = `${member.full_name}${member.is_team_contact ? " · Team leader" : ""}`;
    const details = document.createElement("span");
    details.textContent = [
      member.college_name,
      member.email,
      member.mobile_number,
      member.register_number ? `Register no. ${member.register_number}` : "",
    ].filter(Boolean).join(" · ");
    row.append(name, details);
    memberList.append(row);
  }

  const paymentStatus = team.payment_status.replaceAll("_", " ");
  const paymentStatusElement = document.querySelector("#profile-team-payment");
  paymentStatusElement.textContent = paymentStatus;
  paymentStatusElement.dataset.status = team.payment_status;
  document.querySelector("#profile-payment-utr").textContent = team.payment_utr || "Not submitted";
  document.querySelector("#profile-payment-submitted").textContent =
    team.payment_submitted_at ? new Date(team.payment_submitted_at).toLocaleString() : "Not submitted";
  const proofContainer = document.querySelector("#profile-payment-proof");
  const proofImage = document.querySelector("#profile-payment-proof-image");
  const proofMessage = document.querySelector("#profile-payment-proof-message");
  proofContainer.hidden = true;
  proofImage.removeAttribute("src");
  proofImage.hidden = false;
  proofMessage.hidden = true;
  if (team.is_team_contact && team.screenshot_path) {
    const { data: proofData, error: proofError } = await supabase.storage
      .from(PAYMENT_BUCKET)
      .createSignedUrl(team.screenshot_path, 300);
    if (participantUser?.id !== userId) return;
    if (proofError) {
      console.error("Could not create a signed URL for the participant's payment proof.", proofError);
      proofContainer.hidden = false;
      proofImage.hidden = true;
      proofMessage.textContent = "Your payment proof preview is temporarily unavailable.";
      proofMessage.hidden = false;
    } else {
      proofImage.src = proofData.signedUrl;
      proofContainer.hidden = false;
    }
  }
  paymentCard.hidden = team.payment_status === "not_required";
  document.querySelector("#profile-payment-edit-notice").hidden = !(
    team.is_team_contact === true &&
    Boolean(team.screenshot_path) &&
    team.can_resubmit !== true
  );

  if (
    team.is_team_contact === true &&
    team.payment_status === "rejected" &&
    team.can_resubmit === true
  ) {
    const initialPaymentForm = document.querySelector("#profile-payment-resubmit");
    document.querySelector("#profile-payment-form-title").textContent = "Upload a new payment proof";
    document.querySelector("#profile-payment-resubmit-button").innerHTML =
      "Resubmit payment proof <span>↗</span>";
    document.querySelector("#profile-payment-note").textContent = team.payment_note
      || "An organizer requested a new payment proof. Enter the UTR and upload a clear screenshot.";
    document.querySelector("#profile-payment-utr-input").value = team.payment_utr ?? "";
    document.querySelector("#profile-payment-edit-notice").hidden = true;
    initialPaymentForm.hidden = false;
  }
  teamCard.hidden = false;
  teamMessage.textContent = "";
  registerLink.hidden = paymentSubmitted || !team.is_team_contact;
  if (!paymentSubmitted && team.is_team_contact) {
    registerLink.innerHTML = "Continue to payment <span>↗</span>";
  }
  refreshRegistrationState();
}

document.querySelector("#profile-payment-screenshot").addEventListener("change", (event) => {
  const input = event.currentTarget;
  const file = event.currentTarget.files?.[0];
  const preview = document.querySelector("#profile-payment-preview");
  revokePreviewUrl(preview);
  preview.replaceChildren();
  preview.hidden = true;
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    event.currentTarget.value = "";
    showToast("Choose a PNG, JPG, or WEBP image.");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    event.currentTarget.value = "";
    showToast("The screenshot must be 5 MB or smaller.");
    return;
  }
  const previewUrl = URL.createObjectURL(file);
  preview.dataset.previewUrl = previewUrl;
  const image = document.createElement("img");
  image.src = previewUrl;
  image.alt = "Preview of the replacement payment screenshot";
  preview.append(image);
  addScreenshotRemoveButton(preview, () => {
    revokePreviewUrl(preview);
    input.value = "";
    input.hidden = false;
    preview.replaceChildren();
    preview.hidden = true;
  });
  input.hidden = true;
  preview.hidden = false;
});

document.querySelector("#profile-payment-resubmit").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!supabase || !activeParticipantTeam) return;
  if (activeParticipantTeam.can_resubmit !== true) {
    showToast("Payment resubmission is available only after an admin requests a re-upload.");
    return;
  }
  if (!form.reportValidity()) return;
  const fileInput = document.querySelector("#profile-payment-screenshot");
  const file = fileInput.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast("The screenshot must be 5 MB or smaller.");
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Uploading new proof…";
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${activeParticipantTeam.team_id}/${crypto.randomUUID()}-${safeFileName}`;
  try {
    const { error: uploadError } = await supabase.storage
      .from(PAYMENT_BUCKET)
      .upload(storagePath, file, {
        cacheControl: "3600",
        contentType: file.type,
        upsert: false,
      });
    if (uploadError) {
      console.error("Replacement IdeaForge payment proof upload failed.", uploadError);
      showToast(uploadError.message || "Could not upload the new payment proof.");
      return;
    }

    const { error } = await supabase.rpc("ideaforge_submit_payment", {
      p_team_id: activeParticipantTeam.team_id,
      p_utr: String(new FormData(form).get("utr")).trim(),
      p_screenshot_path: storagePath,
    });
    if (error) {
      console.error("Could not resubmit IdeaForge payment proof.", error);
      showToast(error.message || "Could not resubmit payment proof.");
      return;
    }
    form.reset();
    const preview = document.querySelector("#profile-payment-preview");
    revokePreviewUrl(preview);
    preview.replaceChildren();
    preview.hidden = true;
    fileInput.hidden = false;
    await loadParticipantTeam(participantUser.id);
    showToast("New payment proof submitted for admin review.");
  } catch (error) {
    console.error("Unexpected error resubmitting IdeaForge payment proof.", error);
    showToast("Could not resubmit payment proof because of a network error.");
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = "Resubmit payment proof <span>↗</span>";
  }
});

if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (session) clearOAuthTokensFromUrl();
    updateParticipantProfile(session?.user ?? null);
    participantAuthReady = true;
    window.setTimeout(() => {
      if (isAdminRoute()) {
        if (!session || event === "SIGNED_IN" || event === "INITIAL_SESSION") {
          void renderAdmin();
        }
        return;
      }
      if (session) {
        if (sessionStorage.getItem("ideaforge_admin_intent") === "1") {
          sessionStorage.removeItem("ideaforge_admin_intent");
          window.location.pathname = "/wasd4381";
          window.location.search = "";
          window.location.hash = "";
          return;
        }
        const participantIntent = sessionStorage.getItem("ideaforge_participant_intent");
        if (participantIntent) {
          sessionStorage.removeItem("ideaforge_participant_intent");
          window.location.hash = participantIntent === "register" ? "#register" : "#profile";
          renderRoute();
          return;
        }
        if (event === "SIGNED_IN") {
          window.location.hash = "#profile";
          renderRoute();
          return;
        }
      }
      refreshRegistrationState();
    }, 0);
  });

  supabase.auth.getSession().then(async ({ data, error }) => {
    clearOAuthTokensFromUrl();
    if (error) {
      console.error("Could not restore IdeaForge participant session.", error);
      updateParticipantProfile(null);
    } else {
      updateParticipantProfile(data.session?.user ?? null);
    }
    participantAuthReady = true;
    if (!isAdminRoute()) {
      if (data.session && sessionStorage.getItem("ideaforge_admin_intent") === "1") {
        sessionStorage.removeItem("ideaforge_admin_intent");
        window.location.pathname = "/wasd4381";
        window.location.search = "";
        window.location.hash = "";
        return;
      }
      const participantIntent = sessionStorage.getItem("ideaforge_participant_intent");
      if (data.session && participantIntent) {
        sessionStorage.removeItem("ideaforge_participant_intent");
        window.location.hash = participantIntent === "register" ? "#register" : "#profile";
        renderRoute();
        return;
      }
      refreshRegistrationState();
    }
  }).catch((error) => {
    clearOAuthTokensFromUrl();
    console.error("Could not initialize IdeaForge authentication.", error);
    participantAuthReady = true;
    updateParticipantProfile(null);
    if (!isAdminRoute()) refreshRegistrationState();
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function addScreenshotRemoveButton(preview, onRemove) {
  const removeButton = document.createElement("button");
  removeButton.className = "screenshot-remove";
  removeButton.type = "button";
  removeButton.setAttribute("aria-label", "Remove selected screenshot");
  removeButton.textContent = "×";
  removeButton.addEventListener("click", onRemove);
  preview.append(removeButton);
}

function revokePreviewUrl(preview) {
  const previewUrl = preview.dataset.previewUrl;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  delete preview.dataset.previewUrl;
}

function showToast(message, isAdmin = false) {
  const element = isAdmin ? adminToast : toast;
  if (!element) return;
  element.textContent = message;
  element.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove("visible"), 4200);
}

function renderMembers() {
  const previousValues = new Map(
    [...membersList.querySelectorAll("input")].map((input) => [input.id, input.value]),
  );
  const isInternal = document.querySelector("#registration-type")?.value === "internal";
  membersList.innerHTML = "";
  for (let index = 0; index < memberCount; index += 1) {
    const card = document.createElement("section");
    card.className = "member-card";
    card.innerHTML = `
      <div class="member-card-top"><span>Member ${index + 1}</span><span>${index === 0 ? "TEAM CONTACT" : "PARTICIPANT"}</span></div>
      <div class="member-fields">
        <div><label class="field-label" for="member-${index}-name">Full name <span>*</span></label><input class="text-input" id="member-${index}-name" name="memberName" autocomplete="name" maxlength="100" required /></div>
        <div><label class="field-label" for="member-${index}-college">College name <span>*</span></label><input class="text-input" id="member-${index}-college" name="memberCollege" maxlength="160" required /></div>
        <div><label class="field-label" for="member-${index}-mobile">Mobile number <span>*</span></label><input class="text-input" id="member-${index}-mobile" name="memberMobile" type="tel" inputmode="tel" autocomplete="tel" minlength="7" maxlength="18" title="Enter a valid mobile number" required /></div>
        <div><label class="field-label" for="member-${index}-email">Email address <span>*</span></label><input class="text-input" id="member-${index}-email" name="memberEmail" type="email" autocomplete="email" maxlength="254" required /></div>
        <div class="register-number-field" ${isInternal ? "" : "hidden"}><label class="field-label" for="member-${index}-register-number">Register number <span>*</span></label><input class="text-input" id="member-${index}-register-number" name="memberRegisterNumber" maxlength="40" autocomplete="off" placeholder="College register number" ${isInternal ? "required" : "disabled"} /></div>
      </div>`;
    membersList.append(card);
  }
  for (const input of membersList.querySelectorAll("input")) {
    input.value = previousValues.get(input.id) ?? "";
  }
  const teamContactEmail = document.querySelector("#member-0-email");
  if (teamContactEmail) {
    teamContactEmail.value = participantUser?.email ?? previousValues.get("member-0-email") ?? "";
    teamContactEmail.readOnly = Boolean(participantUser?.email);
  }
  document.querySelector("#member-count").textContent = `${memberCount} / ${MAX_MEMBER_COUNT}`;
  document.querySelector("#add-member").disabled = memberCount >= MAX_MEMBER_COUNT;
  document.querySelector("#remove-member").disabled = memberCount <= INITIAL_MEMBER_COUNT;
  const submitButton = document.querySelector("#team-form-submit");
  if (submitButton) {
    submitButton.innerHTML = isInternal
      ? "Complete free registration <span>↗</span>"
      : "Continue to payment <span>→</span>";
  }
  const stepIndicator = document.querySelector("#team-form-step");
  if (stepIndicator) {
    stepIndicator.textContent = isInternal ? "INTERNAL REGISTRATION" : "STEP 01 / 02";
  }
}

function refreshRegistrationState() {
  const setup = document.querySelector("#registration-setup");
  const configError = document.querySelector("#registration-config-error");
  const closed = document.querySelector("#registration-closed");
  const authRequired = document.querySelector("#registration-auth-required");
  const alreadyRegistered = document.querySelector("#registration-already-registered");
  const incompleteRegistration = document.querySelector("#registration-incomplete");
  setup.hidden = true;
  configError.hidden = true;
  closed.hidden = true;
  authRequired.hidden = true;
  alreadyRegistered.hidden = true;
  incompleteRegistration.hidden = true;
  teamForm.hidden = true;
  paymentForm.hidden = true;

  if (!participantAuthReady) {
    setup.hidden = false;
    setup.querySelector("strong").textContent = "Checking sign-in…";
    setup.querySelector("p").textContent = "Please wait while we restore your account.";
    return;
  }

  if (participantUser && participantTeamStatus === "checking") {
    setup.hidden = false;
    setup.querySelector("strong").textContent = "Checking your registration…";
    setup.querySelector("p").textContent = "Please wait while we look up your account.";
    return;
  }

  if (participantUser && participantTeamStatus === "error") {
    configError.hidden = false;
    document.querySelector("#registration-config-message").textContent =
      "We could not confirm whether your account is already registered. Reload before trying again.";
    return;
  }

  if (participantUser && participantTeamStatus === "registered") {
    alreadyRegistered.hidden = !successPanel.hidden;
    return;
  }

  if (participantUser && participantTeamStatus === "incomplete") {
    if (activeParticipantTeam && !activeParticipantTeam.is_team_contact) {
      incompleteRegistration.querySelector("p").textContent =
        "Your team details are saved, but only the team leader can submit the UTR and payment screenshot.";
    } else {
      incompleteRegistration.querySelector("p").textContent =
        "Submit your UTR and payment screenshot from your profile to complete registration.";
    }
    incompleteRegistration.hidden = Boolean(draftTeam) || !successPanel.hidden;
    paymentForm.hidden = !draftTeam || !successPanel.hidden;
    return;
  }

  if (!supabase) {
    configError.hidden = false;
    document.querySelector("#registration-config-message").textContent =
      "The Supabase URL and anon key are not configured for this deployment.";
    return;
  }

  setup.hidden = false;
  setup.querySelector("strong").textContent = "Checking registration…";
  setup.querySelector("p").textContent = "Please wait while we check the event status.";
  const connectionTimeout = window.setTimeout(() => {
    setup.hidden = true;
    configError.hidden = false;
    document.querySelector("#registration-config-message").textContent =
      "Supabase is taking too long to respond. Please try again later.";
  }, 10000);

  supabase
    .from("ideaforge_settings")
    .select("registration_open")
    .eq("id", true)
    .single()
    .then(({ data, error }) => {
      window.clearTimeout(connectionTimeout);
      setup.hidden = true;
      if (error) {
        console.error("Could not check IdeaForge registration status.", error);
        configError.hidden = false;
        document.querySelector("#registration-config-message").textContent =
          error.message?.toLowerCase().includes("invalid api key")
            ? "Supabase rejected the frontend API key. Copy this project's anon/publishable key into ideaforge/.env as VITE_SUPABASE_ANON_KEY, then restart the local server."
            : "We could not check registration status. Please try again later.";
        return;
      }

      const isOpen = data.registration_open;
      closed.hidden = isOpen || participantTeamStatus === "registered";
      authRequired.hidden = !isOpen || Boolean(participantUser);
      teamForm.hidden = !isOpen || !participantUser || Boolean(draftTeam) || !successPanel.hidden;
      paymentForm.hidden = !isOpen || !participantUser || !draftTeam || !successPanel.hidden;
    })
    .catch((error) => {
      window.clearTimeout(connectionTimeout);
      console.error("Could not reach IdeaForge registration settings.", error);
      setup.hidden = true;
      configError.hidden = false;
      document.querySelector("#registration-config-message").textContent =
        "We could not reach registration services. Please try again later.";
    });
}

function getMembersFromForm() {
  const values = new FormData(teamForm);
  const names = values.getAll("memberName");
  const colleges = values.getAll("memberCollege");
  const mobiles = values.getAll("memberMobile");
  const emails = values.getAll("memberEmail");
  const isInternal = values.get("registrationType") === "internal";
  return names.map((name, index) => ({
    name: String(name).trim(),
    college: String(colleges[index]).trim(),
    mobile: String(mobiles[index]).trim(),
    email: String(emails[index]).trim(),
    registerNumber: isInternal
      ? document.querySelector(`#member-${index}-register-number`).value.trim()
      : null,
  }));
}

function validateTeamFormFields() {
  const teamName = document.querySelector("#team-name");
  const trimmedTeamName = teamName.value.trim();
  teamName.setCustomValidity(
    trimmedTeamName.length < 2 || trimmedTeamName.length > 60
      ? "Enter a team name between 2 and 60 characters."
      : "",
  );

  const emailInputs = [...teamForm.querySelectorAll('input[name="memberEmail"]')];
  const normalizedEmails = emailInputs.map((input) => input.value.trim().toLowerCase());
  const isInternal = document.querySelector("#registration-type")?.value === "internal";
  const registerInputs = isInternal ? [...teamForm.querySelectorAll('input[name="memberRegisterNumber"]')] : [];
  const normalizedRegisterNumbers = registerInputs.map((input) => input.value.trim().toLowerCase());
  for (let index = 0; index < memberCount; index += 1) {
    const nameInput = document.querySelector(`#member-${index}-name`);
    const collegeInput = document.querySelector(`#member-${index}-college`);
    const mobileInput = document.querySelector(`#member-${index}-mobile`);
    const emailInput = emailInputs[index];
    const registerNumberInput = document.querySelector(`#member-${index}-register-number`);
    const name = nameInput.value.trim();
    const college = collegeInput.value.trim();
    const mobile = mobileInput.value.trim();
    const email = normalizedEmails[index];

    nameInput.setCustomValidity(
      name.length === 0 || name.length > 100
        ? "Enter this member's full name (up to 100 characters)."
        : "",
    );
    collegeInput.setCustomValidity(
      college.length === 0 || college.length > 160
        ? "Enter this member's college name (up to 160 characters)."
        : "",
    );
    mobileInput.setCustomValidity(
      !/^[0-9+() -]{7,18}$/.test(mobile)
        ? "Enter a valid mobile number using 7–18 digits and + ( ) - characters."
        : "",
    );

    const isDuplicate = email !== "" && normalizedEmails.indexOf(email) !== index;
    emailInput.setCustomValidity(
      isDuplicate
        ? "Each team member must use a different email address."
        : index === 0 && participantUser?.email
            && email !== participantUser.email.trim().toLowerCase()
          ? "The team leader's email must match the signed-in account."
          : "",
    );
    if (registerNumberInput && !registerNumberInput.disabled) {
      const registerNumber = registerNumberInput.value.trim();
      registerNumberInput.setCustomValidity(
        registerNumber.length === 0 || registerNumber.length > 40
          ? "Enter this member's register number (up to 40 characters)."
          : registerNumber !== "" && normalizedRegisterNumbers.indexOf(registerNumber.toLowerCase()) !== index
            ? "Each team member must provide a unique register number."
          : "",
      );
    }
  }

  return teamForm.checkValidity();
}

teamForm.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement) validateTeamFormFields();
});

document.querySelector("#registration-type")?.addEventListener("change", () => {
  renderMembers();
  validateTeamFormFields();
});

function resetRegistrationForm() {
  teamForm.reset();
  paymentForm.reset();
  draftTeam = null;
  if (selectedScreenshot?.previewUrl) {
    URL.revokeObjectURL(selectedScreenshot.previewUrl);
  }
  selectedScreenshot = null;
  memberCount = INITIAL_MEMBER_COUNT;
  renderMembers();
  document.querySelector("#screenshot-preview").hidden = true;
  document.querySelector("#screenshot-preview").textContent = "";
  teamForm.hidden = false;
  paymentForm.hidden = true;
  successPanel.hidden = true;
  refreshRegistrationState();
}

document.querySelector("#add-member").addEventListener("click", () => {
  if (memberCount < MAX_MEMBER_COUNT) {
    memberCount += 1;
    renderMembers();
  }
});

async function startParticipantGoogleSignIn(returnIntent = "profile") {
  if (!supabase) {
    showToast("Sign-in is not available because Supabase is not configured.");
    return;
  }
  const buttons = document.querySelectorAll("#participant-google-sign-in, #registration-google-sign-in");
  buttons.forEach((btn) => {
    btn.disabled = true;
    btn.textContent = "Opening Google…";
  });
  const profileLink = document.querySelector("#profile-nav-link");
  if (profileLink && !participantUser) {
    profileLink.textContent = "Opening Google…";
  }
  const goToSignInLink = document.querySelector("#go-to-sign-in-link");
  if (goToSignInLink) {
    goToSignInLink.textContent = "Opening Google…";
  }

  try {
    sessionStorage.setItem("ideaforge_participant_intent", returnIntent);
    const redirectTo = `${window.location.origin}/`;
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });
    if (error) {
      console.error("Participant Google sign-in could not be started.", error);
      sessionStorage.removeItem("ideaforge_participant_intent");
      showToast(error.message || "Google sign-in could not be started. Please try again.");
      buttons.forEach((btn) => {
        btn.disabled = false;
        btn.innerHTML = 'Continue with Google <span>↗</span>';
      });
      if (profileLink && !participantUser) {
        profileLink.textContent = "Sign in / Profile";
      }
      if (goToSignInLink) {
        goToSignInLink.innerHTML = 'Go to sign in <span>↗</span>';
      }
      return;
    }
    if (data?.url) {
      window.location.assign(data.url);
    }
  } catch (error) {
    console.error("Unexpected error starting participant Google sign-in.", error);
    sessionStorage.removeItem("ideaforge_participant_intent");
    showToast(error instanceof Error ? error.message : "Google sign-in could not be started. Please try again.");
    buttons.forEach((btn) => {
      btn.disabled = false;
      btn.innerHTML = 'Continue with Google <span>↗</span>';
    });
    if (profileLink && !participantUser) {
      profileLink.textContent = "Sign in / Profile";
    }
    if (goToSignInLink) {
      goToSignInLink.innerHTML = 'Go to sign in <span>↗</span>';
    }
  }
}

document.querySelector("#participant-sign-out").addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("Could not sign out IdeaForge participant.", error);
    showToast("Could not sign out. Please try again.");
    return;
  }
  window.location.hash = "#profile";
});

document.querySelector("#remove-member").addEventListener("click", () => {
  if (memberCount > INITIAL_MEMBER_COUNT) {
    memberCount -= 1;
    renderMembers();
  }
});

teamForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  validateTeamFormFields();
  if (!teamForm.reportValidity()) return;
  if (!supabase) {
    showToast("Registration services are not configured yet.");
    return;
  }
  const members = getMembersFromForm();
  if (members.length < INITIAL_MEMBER_COUNT || members.length > MAX_MEMBER_COUNT) {
    showToast("A team must have between 2 and 5 members.");
    return;
  }
  const submitButton = teamForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.dataset.originalText = submitButton.innerHTML;
  submitButton.textContent = "Saving team…";
  try {
    const { data: teamId, error } = await supabase.rpc("ideaforge_register_team", {
      p_team_name: String(new FormData(teamForm).get("teamName")).trim(),
      p_registration_type: String(new FormData(teamForm).get("registrationType")),
      p_members: members.map((member) => ({
        full_name: member.name,
        college_name: member.college,
        mobile_number: member.mobile,
        email: member.email,
        register_number: member.registerNumber,
      })),
    });

    if (error) {
      console.error("IdeaForge team registration failed.", error);
      const duplicateEmail =
        error.code === "23505" &&
        [error.message, error.details, error.hint].some((value) =>
          value?.includes("ideaforge_members_email_unique"),
        );
      showToast(
        duplicateEmail
          ? "This team includes an email already registered for the hackathon. If it is your account, view your profile; otherwise use a different email for that member."
          : error.message || "Could not save your team. Please try again.",
      );
      return;
    }

    draftTeam = {
      id: teamId,
      teamName: String(new FormData(teamForm).get("teamName")).trim(),
      members,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Unexpected error while registering IdeaForge team.", error);
    showToast("Could not save your team because of a network error. Please try again.");
    return;
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = submitButton.dataset.originalText;
  }

  teamForm.hidden = true;
  if (String(new FormData(teamForm).get("registrationType")) === "internal") {
    document.querySelector("#success-message").textContent =
      `${draftTeam.teamName} is registered as an internal team. Your registration is free.`;
    const registrationCodeWrap = document.querySelector("#success-registration-wrap");
    registrationCodeWrap.hidden = true;
    try {
      const { data: registeredTeam, error: teamProfileError } = await supabase.rpc(
        "ideaforge_get_my_team",
      );
      if (teamProfileError) {
        console.error("Could not load the new team's registration code.", teamProfileError);
      } else if (registeredTeam?.team_code) {
        document.querySelector("#success-registration-code").textContent =
          registeredTeam.team_code;
        registrationCodeWrap.hidden = false;
      }
    } catch (error) {
      console.error("Could not load the new team's registration code.", error);
    }
    draftTeam = null;
    successPanel.hidden = false;
    if (participantUser) void loadParticipantTeam(participantUser.id);
    successPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  document.querySelector("#payment-team-summary").textContent =
    `${draftTeam.teamName} · ${members.length} members · Team contact: ${members[0].name}`;
  const paymentAmountEl = document.querySelector("#payment-amount");
  if (paymentAmountEl) {
    paymentAmountEl.textContent = `₹${members.length * 99}`;
  }
  paymentForm.hidden = false;
  paymentForm.scrollIntoView({ behavior: "smooth", block: "center" });
});

document.querySelector("#back-to-team").addEventListener("click", () => {
  paymentForm.hidden = true;
  teamForm.hidden = false;
});

document.querySelector("#payment-screenshot").addEventListener("change", (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  const preview = document.querySelector("#screenshot-preview");
  if (!file) {
    selectedScreenshot = null;
    document.querySelector("#upload-label").hidden = false;
    preview.replaceChildren();
    preview.hidden = true;
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    input.value = "";
    document.querySelector("#upload-label").hidden = false;
    showToast("Choose a PNG, JPG, or WEBP image.");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    input.value = "";
    document.querySelector("#upload-label").hidden = false;
    showToast("The screenshot must be 5 MB or smaller.");
    return;
  }
  if (selectedScreenshot?.previewUrl) {
    URL.revokeObjectURL(selectedScreenshot.previewUrl);
  }
  const previewUrl = URL.createObjectURL(file);
  selectedScreenshot = { file, name: file.name, previewUrl, storagePath: null };
  preview.replaceChildren();
  const label = document.createElement("span");
  label.textContent = `Selected: ${file.name}`;
  const image = document.createElement("img");
  image.src = previewUrl;
  image.alt = "Preview of the selected payment screenshot";
  preview.append(label, image);
  addScreenshotRemoveButton(preview, () => {
    if (selectedScreenshot?.previewUrl) {
      URL.revokeObjectURL(selectedScreenshot.previewUrl);
    }
    selectedScreenshot = null;
    input.value = "";
    document.querySelector("#upload-label").hidden = false;
    preview.replaceChildren();
    preview.hidden = true;
  });
  document.querySelector("#upload-label").hidden = true;
  preview.hidden = false;
});

paymentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!paymentForm.reportValidity()) return;
  if (!draftTeam || !selectedScreenshot) {
    showToast("Add the payment screenshot before submitting.");
    return;
  }
  if (!supabase) {
    showToast("Registration services are not configured yet.");
    return;
  }
  const utr = String(new FormData(paymentForm).get("utr")).trim();
  const submitButton = paymentForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.dataset.originalText = submitButton.innerHTML;
  submitButton.textContent = "Uploading payment proof…";

  try {
    if (!selectedScreenshot.storagePath) {
      const safeFileName = selectedScreenshot.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      selectedScreenshot.storagePath =
        `${draftTeam.id}/${crypto.randomUUID()}-${safeFileName}`;

      const { error: uploadError } = await supabase.storage
        .from(PAYMENT_BUCKET)
        .upload(selectedScreenshot.storagePath, selectedScreenshot.file, {
          cacheControl: "3600",
          contentType: selectedScreenshot.file.type,
          upsert: false,
        });

      if (uploadError) {
        selectedScreenshot.storagePath = null;
        console.error("IdeaForge payment screenshot upload failed.", uploadError);
        showToast(uploadError.message || "Could not upload the screenshot. Please try again.");
        return;
      }
    }

    const { error } = await supabase.rpc("ideaforge_submit_payment", {
      p_team_id: draftTeam.id,
      p_utr: utr,
      p_screenshot_path: selectedScreenshot.storagePath,
    });

    if (error) {
      console.error("IdeaForge payment submission failed.", error);
      showToast(error.message || "Could not submit payment details. Please try again.");
      return;
    }

    const teamName = draftTeam.teamName;
    document.querySelector("#success-message").textContent =
      `${teamName} is registered. Your payment proof has been submitted and is awaiting admin review.`;
    const registrationCodeWrap = document.querySelector("#success-registration-wrap");
    registrationCodeWrap.hidden = true;
    try {
      const { data: registeredTeam, error: teamProfileError } = await supabase.rpc(
        "ideaforge_get_my_team",
      );
      if (teamProfileError) {
        console.error("Could not load the new team's registration code.", teamProfileError);
      } else if (registeredTeam?.team_code) {
        document.querySelector("#success-registration-code").textContent =
          registeredTeam.team_code;
        registrationCodeWrap.hidden = false;
      }
    } catch (error) {
      console.error("Could not load the new team's registration code.", error);
    }
    if (selectedScreenshot.previewUrl) {
      URL.revokeObjectURL(selectedScreenshot.previewUrl);
    }
    draftTeam = null;
    selectedScreenshot = null;
    paymentForm.hidden = true;
    successPanel.hidden = false;
    if (participantUser) void loadParticipantTeam(participantUser.id);
    successPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    console.error("Unexpected error while submitting IdeaForge payment details.", error);
    showToast("Could not submit payment details because of a network error. Please try again.");
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = submitButton.dataset.originalText;
  }
});

document.querySelector("#copy-registration-code").addEventListener("click", async () => {
  const code = document.querySelector("#success-registration-code").textContent;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast("Team registration code copied.");
  } catch (error) {
    console.error("Could not copy the team registration code.", error);
    showToast("Could not copy the code. Please select and copy it manually.");
  }
});

let activeAdmin = null;

function setAdminAuthenticated(isAuthenticated) {
  adminView.classList.toggle("admin-authenticated", isAuthenticated);
}

function showAdminConnectionError(message) {
  setAdminAuthenticated(false);
  document.querySelector("#admin-dashboard").hidden = true;
  document.querySelector("#admin-login-panel").hidden = true;
  document.querySelector("#admin-connection-error").hidden = false;
  document.querySelector("#admin-connection-message").textContent = message;
}

function showAdminLogin(message, canSignOut = false) {
  setAdminAuthenticated(false);
  document.querySelector("#admin-dashboard").hidden = true;
  document.querySelector("#admin-connection-error").hidden = true;
  document.querySelector("#admin-login-panel").hidden = false;
  document.querySelector("#admin-login-message").textContent = message;
  document.querySelector("#admin-sign-out").hidden = !canSignOut;
}

function setAdminPage(pageName) {
  const pageDetails = {
    overview: ["Dashboard overview", "Here’s what’s happening with your hackathon today."],
    payments: ["Payments", "Review registration details, payment references, and proofs."],
    users: ["Registered users", "Find participants and see their team and payment status."],
    checkin: ["Team check-in", "Display a temporary check-in QR or search for a team manually."],
    emails: ["Gmail outbox", "Review queued confirmations and retry eligible failures."],
    registrations: ["Registrations", "Review team registrations and payment status."],
    students: ["Students", "Find participants and see their team and payment status."],
    teams: ["Teams", "Browse registered teams and their members."],
    reuploads: ["Re-uploads", "Review payment proofs that need a new upload."],
    "deleted-history": ["Deleted history", "Review historical registration removals."],
    "email-queue": ["Email queue", "Review queued confirmations and retry eligible failures."],
    "qr-toggle": ["QR scanner toggle", "Control whether participants can access profile check-in scanning."],
    "qr-display": ["Display check-in QR", "Active check-in QR code for participant profile scanners."],
    events: ["Events", "Event registration and operations overview."],
  };
  const pageSections = {
    overview: "overview",
    events: "overview",
    payments: "payments",
    registrations: "payments",
    reuploads: "payments",
    users: "users",
    students: "users",
    teams: "users",
    checkin: "checkin",
    emails: "emails",
    "email-queue": "emails",
    "qr-toggle": "checkin-toggle",
    "qr-display": "qr-display",
    "deleted-history": "deleted-history",
  };
  const sectionName = pageSections[pageName] ?? "overview";
  for (const page of document.querySelectorAll(".admin-page")) {
    page.hidden = page.id !== `admin-${sectionName}-page`;
  }
  for (const button of document.querySelectorAll(".admin-nav-button")) {
    button.classList.toggle(
      "active",
      (button.dataset.adminPage ?? button.dataset.adminRoute) === pageName,
    );
  }
  const [title, description] = pageDetails[pageName] ?? pageDetails.overview;
  document.querySelector("#admin-current-page").textContent = title;
  document.querySelector("#admin-page-title").textContent = title;
  document.querySelector("#admin-page-description").textContent = description;
  const paymentFilter = document.querySelector("#admin-payment-filter");
  if (sectionName === "payments") {
    paymentFilter.value = pageName === "reuploads" ? "rejected" : "all";
    filterAdminPayments();
  }
  if (sectionName === "deleted-history") {
    void loadAdminDeletedHistory();
  }
  document.querySelector("#admin-sidebar").classList.remove("open");
  document.querySelector("#admin-menu-toggle").setAttribute("aria-expanded", "false");
}

async function renderAdmin() {
  const loginPanel = document.querySelector("#admin-login-panel");
  const dashboard = document.querySelector("#admin-dashboard");
  const connectionError = document.querySelector("#admin-connection-error");
  const signOutButton = document.querySelector("#admin-sign-out");

  activeAdmin = null;
  const emailQueueRoute = isEmailQueueRoute();
  const checkinToggleRoute = isCheckinToggleRoute();
  const qrDisplayRoute = isQrDisplayRoute();
  adminView.classList.toggle("admin-email-only", emailQueueRoute);
  adminView.classList.toggle("admin-nested-route", emailQueueRoute || checkinToggleRoute || qrDisplayRoute);
  adminView.classList.toggle("admin-checkin-toggle-only", checkinToggleRoute);
  adminView.classList.toggle("admin-qr-display-only", qrDisplayRoute);
  setAdminAuthenticated(false);
  loginPanel.hidden = true;
  dashboard.hidden = true;
  connectionError.hidden = true;
  signOutButton.hidden = true;

  if (!supabase) {
    showAdminConnectionError("Supabase is not configured for this deployment.");
    return;
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    console.error("Could not read IdeaForge admin session.", sessionError);
    showAdminConnectionError("Could not check your sign-in. Please reload and try again.");
    return;
  }

  if (!sessionData.session) {
    activeAdmin = null;
    showAdminLogin("Sign in with your approved Google account to manage the hackathon.");
    return;
  }

  const { data: isAdmin, error: adminCheckError } = await supabase.rpc("is_ideaforge_admin");
  if (adminCheckError) {
    console.error("Could not verify IdeaForge admin access.", adminCheckError);
    showAdminConnectionError("Could not verify admin access. Confirm that the database schema is installed.");
    return;
  }

  if (!isAdmin) {
    activeAdmin = null;
    showAdminLogin(
      "You’re signed in, but this Google account is not approved for admin access. Ask an organizer to grant access, or sign out.",
      true,
    );
    return;
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    console.error("Could not read the signed-in IdeaForge admin.", userError);
    showAdminConnectionError("Could not read your admin profile. Please sign in again.");
    return;
  }

  activeAdmin = userData.user;
  const adminName = userData.user.user_metadata?.full_name
    ?? userData.user.user_metadata?.name
    ?? "Administrator";
  const nameParts = adminName.trim().split(/\s+/);
  document.querySelector("#admin-account-name").textContent = adminName;
  document.querySelector("#admin-account-avatar").textContent =
    nameParts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("") || "AD";
  setAdminAuthenticated(true);
  document.querySelector("#toggle-registration").hidden = emailQueueRoute || checkinToggleRoute || qrDisplayRoute;
  signOutButton.hidden = false;
  dashboard.hidden = false;
  setAdminPage(qrDisplayRoute ? "qr-display" : checkinToggleRoute ? "qr-toggle" : emailQueueRoute ? "email-queue" : "overview");
  await loadAdminDashboard();
  if (activeAdmin && checkinToggleRoute) await loadAdminCheckinToggle();
  if (activeAdmin && qrDisplayRoute) {
    const qrBtn = document.querySelector("#create-checkin-qr");
    if (qrBtn && !qrBtn.disabled) qrBtn.click();
  }
}

async function loadAdminCheckinToggle() {
  const button = document.querySelector("#toggle-participant-checkin");
  const status = document.querySelector("#participant-checkin-toggle-status");
  button.disabled = true;
  status.textContent = "Loading the current scanner setting…";
  const { data, error } = await supabase
    .from("ideaforge_settings")
    .select("participant_checkin_enabled")
    .eq("id", true)
    .single();
  if (error) {
    console.error("Could not load the participant check-in setting.", error);
    status.textContent = "Could not load this setting. Apply the participant check-in toggle migration, then reload.";
    button.textContent = "Setting unavailable";
    return;
  }
  adminCheckinEnabled = data.participant_checkin_enabled === true;
  button.disabled = false;
  button.setAttribute("aria-pressed", String(adminCheckinEnabled));
  button.textContent = adminCheckinEnabled
    ? "Disable participant QR scanner"
    : "Enable participant QR scanner";
  status.textContent = adminCheckinEnabled
    ? "Participant check-in scanning is enabled."
    : "Participant check-in scanning is hidden from profiles.";
}

async function fetchAllAdminTeams() {
  const pageSize = 500;
  const teams = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("ideaforge_teams")
      .select("id, team_name, team_code, registration_type, payment_status, payment_utr, screenshot_path, created_at, payment_submitted_at, checked_in_at, ideaforge_members(id, full_name, college_name, mobile_number, register_number, is_team_contact)")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    teams.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return { data: teams, error: null };
}

async function loadAdminDashboard() {
  if (!activeAdmin) return;

  const [settingsResult, teamsResult] = await Promise.all([
    supabase
      .from("ideaforge_settings")
      .select("registration_open")
      .eq("id", true)
      .single(),
    fetchAllAdminTeams(),
  ]);

  if (settingsResult.error) {
    console.error("Could not read IdeaForge admin settings.", settingsResult.error);
    showAdminConnectionError("Could not load registration status. Check your schema and admin permissions.");
    return;
  }
  if (teamsResult.error) {
    console.error("Could not load IdeaForge registrations.", teamsResult.error);
    showAdminConnectionError("Could not load registrations. Apply the IdeaForge admin/check-in migration and verify admin permissions.");
    return;
  }
  const teams = teamsResult.data ?? [];
  const registeredTeams = teams.filter((team) => team.payment_status !== "awaiting_payment");
  adminTeamsData = registeredTeams;
  renderAdminCheckinSearch();
  const membersCount = teams.reduce(
    (total, team) => total + (team.ideaforge_members?.length ?? 0),
    0,
  );
  document.querySelector("#total-teams").textContent = String(teams.length);
  document.querySelector("#total-members").textContent = String(membersCount);
  document.querySelector("#pending-payments").textContent =
    String(teams.filter((team) => team.payment_status === "pending_review").length);
  document.querySelector("#approved-payments").textContent =
    String(teams.filter((team) => team.payment_status === "approved").length);
  document.querySelector("#checked-in-teams").textContent =
    String(teams.filter((team) => team.checked_in_at).length);
  // Show every team in the participant directory, including registrations that
  // never reached payment, so abandoned rows can be reviewed or deleted.
  renderAdminUsers(teams);
  if (isEmailQueueRoute()) {
    const { data: emailRows, error: emailError } = await supabase
      .from("ideaforge_email_outbox")
      .select("id, team_id, status, attempt_count, retryable, last_error, sent_at, recipient_email, recipient_name, created_at")
      .order("created_at", { ascending: false });
    if (emailError) {
      console.error("Could not load IdeaForge delivery queue.", emailError);
      showAdminConnectionError("Could not load delivery status. Check the outbox migration and admin permissions.");
      return;
    }
    renderAdminEmails(emailRows ?? [], registeredTeams);
  }

  const toggle = document.querySelector("#toggle-registration");
  toggle.textContent = settingsResult.data.registration_open ? "Close registration" : "Open registration";
  toggle.dataset.open = String(settingsResult.data.registration_open);

  const list = document.querySelector("#admin-team-list");
  list.replaceChildren();
  const paymentTeams = teams;
  document.querySelector("#admin-payment-count").textContent =
    `${paymentTeams.length} registration${paymentTeams.length === 1 ? "" : "s"}`;

  for (const team of paymentTeams) {
    const members = team.ideaforge_members ?? [];
    const statusLabels = {
      awaiting_payment: "INCOMPLETE · NO PAYMENT",
      pending_review: "PENDING",
      approved: "PAID",
      rejected: "RE-UPLOAD REQUESTED",
      not_required: "FREE · INTERNAL",
    };
    const isPending = team.payment_status === "pending_review";
    const screenshotPath = team.screenshot_path ?? "";

    const membersHtml = members.map((member) => `
      <div class="admin-member-row">
        <strong>${escapeHtml(member.full_name)}${member.is_team_contact ? " · Team contact" : ""}</strong>
        <span>${escapeHtml(member.college_name)} · ${escapeHtml(member.mobile_number)}${member.register_number ? ` · Register no. ${escapeHtml(member.register_number)}` : ""}</span>
      </div>`).join("");
    const teamContact = members.find((member) => member.is_team_contact) ?? members[0];
    const paymentHtml = team.payment_status === "not_required"
      ? '<span class="prototype-note">Free · No payment required</span>'
      : team.payment_status === "awaiting_payment"
        ? '<span class="prototype-note">Registration incomplete — no payment proof submitted</span>'
        : team.payment_utr
          ? `<span class="utr-value">${escapeHtml(team.payment_utr)}</span>
         ${screenshotPath
           ? `<button class="payment-proof-link" type="button" data-payment-proof data-team-id="${escapeHtml(team.id)}" data-team-name="${escapeHtml(team.team_name)}" data-team-code="${escapeHtml(team.team_code ?? "")}" data-contact-name="${escapeHtml(teamContact?.full_name ?? "—")}" data-utr="${escapeHtml(team.payment_utr)}" data-submitted-at="${escapeHtml(team.payment_submitted_at ?? "")}" data-screenshot-path="${escapeHtml(screenshotPath)}">▧ View screenshot</button>`
           : `<span class="prototype-note">Screenshot unavailable</span>`}`
          : "<span class=\"prototype-note\">UTR unavailable</span>";
    const card = document.createElement("article");
    card.className = "admin-team-card";
    card.dataset.paymentStatus = team.payment_status;
    card.innerHTML = `
      <div class="admin-payment-row">
        <div class="payment-team-cell"><strong>${escapeHtml(team.team_name)}</strong><span>${escapeHtml(team.team_code)} · ${team.registration_type === "internal" ? "Internal" : "External"}</span></div>
        <div class="payment-contact-cell"><strong>${escapeHtml(teamContact?.full_name ?? "—")}</strong></div>
        <div class="payment-proof-cell">${paymentHtml}</div>
        <div><span class="status-pill ${team.payment_status === "approved" || team.payment_status === "not_required" ? "approved" : team.payment_status === "rejected" ? "reupload-requested" : ""}">${statusLabels[team.payment_status] ?? "UNKNOWN"}</span></div>
        <div class="payment-date-cell">${team.payment_submitted_at ? new Date(team.payment_submitted_at).toLocaleString() : "—"}</div>
        <div class="admin-payment-actions">
          ${isPending ? `<button class="small-button approve" type="button" data-action="approve" data-team-id="${escapeHtml(team.id)}">✓ Mark paid</button><button class="small-button request-reupload" type="button" data-action="request-reupload" data-team-id="${escapeHtml(team.id)}">↻ Request re-upload</button>` : team.payment_status === "approved" ? '<span class="payment-action-complete">✓ Payment verified</span>' : team.payment_status === "not_required" ? '<span class="payment-action-complete">✓ No payment required</span>' : ""}
          <button class="small-button danger" type="button" data-action="delete-team" data-team-id="${escapeHtml(team.id)}" data-team-name="${escapeHtml(team.team_name)}">🗑 Delete</button>
        </div>
        <details class="admin-payment-details">
          <summary>Team details</summary>
          <div class="admin-payment-detail-body"><section><h4>TEAM MEMBERS</h4>${membersHtml}</section><section><h4>PAYMENT PROOF</h4>${paymentHtml}</section></div>
        </details>
      </div>`;
    list.append(card);
  }
  filterAdminPayments();
}

function renderAdminUsers(teams) {
  const list = document.querySelector("#admin-user-list");
  const search = document.querySelector("#admin-user-search");
  const memberCount = teams.reduce(
    (total, team) => total + (team.ideaforge_members?.length ?? 0),
    0,
  );
  const teamLabel = `${teams.length} team${teams.length === 1 ? "" : "s"}`;
  document.querySelector("#admin-user-count").textContent =
    `${memberCount} participant${memberCount === 1 ? "" : "s"} · ${teamLabel}`;

  list.innerHTML = teams.map((team) => {
    const members = team.ideaforge_members ?? [];
    const teamCodeLabel = team.team_code || "Code issued after payment";
    const teamSearch = `${team.team_name} ${team.team_code ?? ""} ${team.registration_type} ${team.payment_status}`.toLowerCase();
    const memberRows = members.map((member) => {
      const searchText = [
        member.full_name,
        member.college_name,
        member.mobile_number,
        member.register_number,
      ].join(" ").toLowerCase();
      return `<article class="admin-user-row" data-search="${escapeHtml(searchText)}">
        <div class="admin-user-identity">
          <span class="admin-user-avatar" aria-hidden="true">${escapeHtml(String(member.full_name ?? "").trim().charAt(0).toUpperCase() || "?")}</span>
          <div><strong>${escapeHtml(member.full_name)}</strong>${member.is_team_contact ? '<span class="admin-team-leader">TEAM LEADER</span>' : ""}</div>
        </div>
        <div class="admin-user-contact"><span>${escapeHtml(member.mobile_number)}</span></div>
        <div class="admin-user-college">${escapeHtml(member.college_name)}${member.register_number ? `<span class="admin-user-register-number">Register no. ${escapeHtml(member.register_number)}</span>` : ""}</div>
      </article>`;
    }).join("");
    const paymentStatus = team.payment_status ?? "unknown";
    const statusLabel = paymentStatus === "not_required"
      ? "free · internal"
      : paymentStatus === "awaiting_payment"
        ? "awaiting payment"
        : paymentStatus.replaceAll("_", " ");
    return `<section class="admin-user-team" data-team-search="${escapeHtml(teamSearch)}" data-team-id="${escapeHtml(team.id)}" data-team-name="${escapeHtml(team.team_name)}">
      <header class="admin-user-team-heading">
        <div class="admin-user-team-title">
          <span class="admin-user-team-icon" aria-hidden="true">✳</span>
          <div><h3>${escapeHtml(team.team_name)}</h3><span>${escapeHtml(teamCodeLabel)}</span></div>
        </div>
        <div class="admin-user-team-meta">
          <span class="admin-user-team-size">${members.length} member${members.length === 1 ? "" : "s"}</span>
          <span class="status-pill ${paymentStatus === "approved" || paymentStatus === "not_required" ? "approved" : paymentStatus === "rejected" ? "reupload-requested" : ""}">${escapeHtml(statusLabel)}</span>
          <button class="small-button danger" type="button" data-action="delete-team" data-team-id="${escapeHtml(team.id)}" data-team-name="${escapeHtml(team.team_name)}">🗑 Delete</button>
        </div>
      </header>
      <div class="admin-user-team-members">${memberRows || '<p class="admin-user-no-members">No participant details available.</p>'}</div>
    </section>`;
  }).join("");
  filterAdminUsers(search.value);
}

function filterAdminUsers(value) {
  const query = value.trim().toLowerCase();
  const teams = [...document.querySelectorAll("#admin-user-list .admin-user-team")];
  let visibleTeams = 0;
  for (const team of teams) {
    const isTeamMatch = query !== "" && team.dataset.teamSearch.includes(query);
    const members = [...team.querySelectorAll(".admin-user-row")];
    let hasVisibleMember = false;
    for (const member of members) {
      member.hidden = query !== "" && !isTeamMatch && !member.dataset.search.includes(query);
      if (!member.hidden) hasVisibleMember = true;
    }
    if (isTeamMatch) {
      for (const member of members) member.hidden = false;
      hasVisibleMember = true;
    }
    team.hidden = !hasVisibleMember;
    if (!team.hidden) visibleTeams += 1;
  }
  document.querySelector("#admin-users-empty").hidden = visibleTeams > 0;
}

async function loadAdminDeletedHistory() {
  const list = document.querySelector("#admin-deleted-list");
  const empty = document.querySelector("#admin-deleted-empty");
  const count = document.querySelector("#admin-deleted-count");
  if (!list || !empty || !count) return;

  count.textContent = "Loading…";
  list.replaceChildren();
  empty.hidden = true;

  const { data, error } = await supabase
    .from("ideaforge_deleted_teams")
    .select("id, team_id, team_code, team_name, registration_type, payment_status, payment_utr, members, checked_in_at, team_created_at, deleted_at, deleted_by_email, note, screenshot_paths")
    .order("deleted_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("Could not load deleted IdeaForge registrations.", error);
    count.textContent = "Unavailable";
    empty.hidden = false;
    document.querySelector("#admin-deleted-empty strong").textContent = "Could not load deleted history";
    document.querySelector("#admin-deleted-empty p").textContent =
      "Apply the delete-team migration and confirm admin permissions.";
    return;
  }

  const records = data ?? [];
  count.textContent = `${records.length} deleted registration${records.length === 1 ? "" : "s"}`;
  document.querySelector("#admin-deleted-empty strong").textContent = "No deleted registrations";
  document.querySelector("#admin-deleted-empty p").textContent =
    "Teams deleted from the admin console are archived here with their roster and payment details.";

  if (records.length === 0) {
    empty.hidden = false;
    return;
  }

  list.innerHTML = records.map((record) => {
    const members = Array.isArray(record.members) ? record.members : [];
    const memberRows = members.map((member) => `
      <li>
        <strong>${escapeHtml(member.full_name ?? "Unknown participant")}</strong>
        <span>${escapeHtml(member.college_name ?? "—")} · ${escapeHtml(member.mobile_number ?? "—")}${member.register_number ? ` · Reg. ${escapeHtml(member.register_number)}` : ""}${member.is_team_contact ? " · Team contact" : ""}</span>
      </li>`).join("");
    const deletedAt = record.deleted_at
      ? new Date(record.deleted_at).toLocaleString()
      : "—";
    const checkedIn = record.checked_in_at
      ? new Date(record.checked_in_at).toLocaleString()
      : "Not checked in";
    const proofCount = Array.isArray(record.screenshot_paths)
      ? record.screenshot_paths.length
      : 0;
    return `<article class="admin-deleted-card">
      <header>
        <div class="admin-deleted-title">
          <strong>${escapeHtml(record.team_name)}</strong>
          <span>${escapeHtml(record.team_code ?? "No code")} · ${record.registration_type === "internal" ? "Internal" : "External"} · ${members.length} member${members.length === 1 ? "" : "s"}</span>
        </div>
        <div class="admin-deleted-stamp">
          <span>Deleted ${escapeHtml(deletedAt)}</span>
          <span>By ${escapeHtml(record.deleted_by_email ?? "administrator")}</span>
        </div>
      </header>
      <div class="admin-deleted-facts">
        <span>Payment: <b>${escapeHtml(String(record.payment_status ?? "unknown").replaceAll("_", " "))}</b></span>
        <span>UTR: <b>${escapeHtml(record.payment_utr ?? "—")}</b></span>
        <span>Attendance: <b>${escapeHtml(checkedIn)}</b></span>
        <span>Proof files: <b>${proofCount}</b></span>
      </div>
      <details>
        <summary>Archived roster</summary>
        <ul>${memberRows || "<li><span>No member snapshot was recorded.</span></li>"}</ul>
      </details>
      ${record.note ? `<p class="admin-deleted-note">${escapeHtml(record.note)}</p>` : ""}
    </article>`;
  }).join("");
}

function renderAdminEmails(emails, teams) {
  adminEmailsData = emails;
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const list = document.querySelector("#admin-email-list");
  const statusLabels = {
    pending: "Queued",
    sending: "Sending",
    sent: "Accepted by Gmail",
    failed: "Failed",
  };

  const counts = {
    pending: emails.filter((email) => email.status === "pending").length,
    sending: emails.filter((email) => email.status === "sending").length,
    sent: emails.filter((email) => email.status === "sent").length,
    failed: emails.filter((email) => email.status === "failed").length,
  };
  for (const status of Object.keys(counts)) {
    document.querySelector(`#email-${status}-count`).textContent = String(counts[status]);
    document.querySelector(`#email-${status}-tab-count`).textContent = String(counts[status]);
  }
  document.querySelector("#email-all-tab-count").textContent = String(emails.length);
  list.innerHTML = emails.map((email) => {
    const team = teamById.get(email.team_id);
    const status = statusLabels[email.status] ?? "Unknown";
    const retryButton = email.status === "failed" && email.retryable
      ? `<button class="small-button" type="button" data-action="retry-email" data-email-id="${escapeHtml(email.id)}">Retry email</button>`
      : "";
    const searchText = [
      team?.team_name ?? "",
      team?.team_code ?? "",
      email.recipient_name ?? "",
      email.recipient_email ?? "",
    ].join(" ").toLowerCase();
    return `<article class="admin-email-row" data-status="${escapeHtml(email.status)}" data-search="${escapeHtml(searchText)}">
      <div><span class="status-pill ${email.status === "sent" ? "approved" : ""}">${escapeHtml(status)}</span></div>
      <div><strong>${escapeHtml(team?.team_name ?? "Unknown team")}</strong><span>${escapeHtml(team?.team_code ?? "No team code")}</span></div>
      <div><strong>${escapeHtml(email.recipient_name ?? "Team leader")}</strong><span>${escapeHtml(email.recipient_email ?? "No recipient")}</span></div>
      <div><span>${email.attempt_count} attempt${email.attempt_count === 1 ? "" : "s"}</span><span>${new Date(email.created_at).toLocaleString()}</span>${email.last_error ? `<span class="email-error">${escapeHtml(email.last_error)}</span>` : ""}${email.status === "sent" ? "<span>Accepted by Gmail</span>" : ""}</div>
      <div>${retryButton || '<span class="prototype-note">—</span>'}</div>
    </article>`;
  }).join("");
  filterAdminEmails();
}

function filterAdminPayments() {
  const query = document.querySelector("#admin-payment-search").value.trim().toLowerCase();
  const status = document.querySelector("#admin-payment-filter").value;
  const cards = [...document.querySelectorAll("#admin-team-list .admin-team-card")];
  for (const card of cards) {
    card.hidden = (status !== "all" && card.dataset.paymentStatus !== status) ||
      (query !== "" && !card.textContent.toLowerCase().includes(query));
  }
  document.querySelector("#admin-empty").hidden = cards.some((card) => !card.hidden);
}

function filterAdminEmails() {
  const query = document.querySelector("#admin-email-search").value.trim().toLowerCase();
  const rows = [...document.querySelectorAll("#admin-email-list .admin-email-row")];
  for (const row of rows) {
    row.hidden = (activeEmailFilter !== "all" && row.dataset.status !== activeEmailFilter) ||
      (query !== "" && !row.dataset.search.includes(query));
  }
  document.querySelector("#admin-email-empty").hidden = rows.some((row) => !row.hidden);
}

function exportSentEmails() {
  const sent = adminEmailsData.filter((email) => email.status === "sent");
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [
    ["Recipient", "Name", "Status", "Attempts", "Sent at"],
    ...sent.map((email) => [
      email.recipient_email,
      email.recipient_name,
      email.status,
      email.attempt_count,
      email.sent_at,
    ]),
  ];
  const csv = rows.map((row) => row.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "ideaforge-sent-confirmations.csv";
  link.click();
  URL.revokeObjectURL(url);
}

document.querySelector("#admin-google-sign-in").addEventListener("click", async (event) => {
  if (!supabase) {
    showAdminLogin("Supabase is not configured for this deployment.");
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Opening Google…";
  try {
    sessionStorage.setItem("ideaforge_admin_intent", "1");
    const redirectTo = `${window.location.origin}/wasd4381`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) {
      console.error("Google sign-in could not be started.", error);
      sessionStorage.removeItem("ideaforge_admin_intent");
      showAdminLogin("Google sign-in could not be started. Please try again.");
    }
  } catch (error) {
    console.error("Unexpected error starting Google sign-in.", error);
    sessionStorage.removeItem("ideaforge_admin_intent");
    showAdminLogin("Google sign-in could not be started. Please try again.");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Continue with Google <span>↗</span>';
  }
});

document.querySelector("#admin-sign-out").addEventListener("click", async () => {
  stopParticipantCheckinScanner();
  setAdminAuthenticated(false);
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("Could not sign out IdeaForge admin.", error);
    showToast("Could not sign out. Please try again.", true);
    void renderAdmin();
    return;
  }
  activeAdmin = null;
  showAdminLogin("You have signed out.");
});

document.querySelector("#admin-sidebar-sign-out").addEventListener("click", () => {
  document.querySelector("#admin-sign-out").click();
});

document.querySelector("#toggle-registration").addEventListener("click", async (event) => {
  if (!activeAdmin) {
    showToast("Sign in with an approved admin account first.", true);
    return;
  }
  const button = event.currentTarget;
  const nextOpen = button.dataset.open !== "true";
  button.disabled = true;
  try {
    const { error } = await supabase
      .from("ideaforge_settings")
      .update({
        registration_open: nextOpen,
        updated_at: new Date().toISOString(),
        updated_by: activeAdmin.id,
      })
      .eq("id", true);
    if (error) {
      console.error("Could not update IdeaForge registration status.", error);
      showToast(error.message || "Could not update registration status.", true);
      return;
    }
    await loadAdminDashboard();
    showToast(`Registration ${nextOpen ? "opened" : "closed"}.`, true);
  } catch (error) {
    console.error("Unexpected error updating registration status.", error);
    showToast("Could not update registration status because of a network error.", true);
  } finally {
    button.disabled = false;
  }
});

async function deleteAdminTeam(button) {
  if (!activeAdmin) {
    showToast("Sign in with an approved admin account first.", true);
    return;
  }
  const teamId = button.dataset.teamId;
  const teamName = button.dataset.teamName || "this team";
  if (!teamId) return;

  const confirmed = window.confirm(
    `Delete ${teamName}?\n\nThis permanently removes the registration, roster, payment UTR/review history, confirmation email records, and stored payment screenshots from Supabase.\n\nThis cannot be undone.`,
  );
  if (!confirmed) return;

  button.disabled = true;
  try {
    const { data, error } = await supabase.rpc("ideaforge_delete_team", {
      p_team_id: teamId,
      p_note: null,
    });
    if (error) {
      console.error("Could not delete the IdeaForge registration.", error);
      showToast(error.message || "Could not delete this registration.", true);
      button.disabled = false;
      return;
    }

    const paths = Array.isArray(data?.screenshot_paths) ? data.screenshot_paths : [];
    let proofWarning = "";
    if (paths.length > 0) {
      const { error: storageError } = await supabase.storage
        .from(PAYMENT_BUCKET)
        .remove(paths);
      if (storageError) {
        console.error("Could not remove the deleted team's payment proof files.", storageError);
        proofWarning = " The registration was deleted, but its screenshot files could not be removed from Storage.";
      }
    }

    await loadAdminDashboard();
    if (!document.querySelector("#admin-deleted-history-page").hidden) {
      await loadAdminDeletedHistory();
    }
    showToast(`${teamName} was deleted from Supabase.${proofWarning}`, true);
  } catch (error) {
    console.error("Unexpected error deleting an IdeaForge registration.", error);
    showToast("Could not delete the registration because of a network error. Please try again.", true);
    button.disabled = false;
  }
}

document.querySelector("#admin-team-list").addEventListener("click", async (event) => {
  const proofButton = event.target.closest("button[data-payment-proof]");
  if (proofButton) {
    void openPaymentProof(proofButton);
    return;
  }

  const button = event.target.closest("button[data-action]");
  if (!button || !activeAdmin) return;
  if (button.dataset.action === "delete-team") {
    await deleteAdminTeam(button);
    return;
  }
  if (button.dataset.action === "retry-email") {
    await retryAdminEmail(button);
    return;
  }

  if (button.dataset.action === "request-reupload") {
    if (!window.confirm("Request a new payment screenshot and UTR from this team leader?")) return;
    button.disabled = true;
    const { error } = await supabase.rpc("ideaforge_request_payment_reupload", {
      p_team_id: button.dataset.teamId,
      p_note: "Please upload a clear payment screenshot and verify the UTR before resubmitting.",
    });
    if (error) {
      console.error("Could not request an IdeaForge payment re-upload.", error);
      showToast(error.message || "Could not request a new payment proof.", true);
      button.disabled = false;
      return;
    }
    await loadAdminDashboard();
    showToast("Re-upload requested. The team leader can submit new proof from their profile.", true);
    return;
  }

  button.disabled = true;
  const { error } = await supabase.rpc("ideaforge_review_payment", {
    p_team_id: button.dataset.teamId,
    p_decision: "approved",
    p_note: null,
  });
  if (error) {
    console.error("Could not approve IdeaForge payment.", error);
    showToast(error.message || "Could not mark payment as paid.", true);
    button.disabled = false;
    return;
  }
  await loadAdminDashboard();
  showToast("Payment marked as paid.", true);
});

document.querySelector("#admin-user-list").addEventListener("click", async (event) => {
  const button = event.target.closest('button[data-action="delete-team"]');
  if (button && activeAdmin) await deleteAdminTeam(button);
});

async function openPaymentProof(button) {
  const dialog = document.querySelector("#payment-proof-dialog");
  const image = document.querySelector("#payment-proof-image");
  const submittedAt = button.dataset.submittedAt
    ? new Date(button.dataset.submittedAt).toLocaleString()
    : "—";
  const approveButton = document.querySelector("#payment-proof-mark-paid");
  const reuploadButton = document.querySelector("#payment-proof-request-reupload");

  document.querySelector("#payment-proof-title").textContent =
    `Payment Proof · ${button.dataset.contactName}`;
  document.querySelector("#payment-proof-subtitle").textContent =
    `Registration ${button.dataset.teamCode} · ${button.dataset.teamName}`;
  document.querySelector("#payment-proof-utr").textContent = button.dataset.utr;
  document.querySelector("#payment-proof-created-at").textContent = submittedAt;
  image.removeAttribute("src");
  image.alt = `Payment proof for ${button.dataset.teamName}`;
  approveButton.dataset.teamId = button.dataset.teamId;
  reuploadButton.dataset.teamId = button.dataset.teamId;
  dialog.classList.remove("is-full-size");

  const isPending =
    button.closest(".admin-team-card")?.dataset.paymentStatus === "pending_review";
  approveButton.hidden = !isPending;
  reuploadButton.hidden = !isPending;

  const screenshotPath = button.dataset.screenshotPath;
  if (!screenshotPath) {
    showToast("This team has no payment proof stored.", true);
    return;
  }

  dialog.showModal();
  const { data, error } = await supabase.storage
    .from(PAYMENT_BUCKET)
    .createSignedUrl(screenshotPath, 300);
  if (error) {
    console.error("Could not open the payment proof.", error);
    dialog.close();
    showToast(error.message || "Could not open the payment proof.", true);
    return;
  }
  image.src = data.signedUrl;
}

const paymentProofDialog = document.querySelector("#payment-proof-dialog");
paymentProofDialog.addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-proof-dialog-action]");
  if (!actionButton) {
    if (event.target === paymentProofDialog) paymentProofDialog.close();
    return;
  }

  const action = actionButton.dataset.proofDialogAction;
  if (action === "close") {
    paymentProofDialog.close();
  } else if (action === "copy-utr") {
    navigator.clipboard.writeText(
      document.querySelector("#payment-proof-utr").textContent,
    ).then(
      () => showToast("UTR copied to clipboard.", true),
      (error) => {
        console.error("Could not copy the payment UTR.", error);
        showToast("Could not copy the UTR. Please select and copy it manually.", true);
      },
    );
  } else if (action === "full-size") {
    paymentProofDialog.classList.toggle("is-full-size");
    actionButton.textContent = paymentProofDialog.classList.contains("is-full-size")
      ? "↙ Fit to screen"
      : "↗ Full Size";
  } else if (action === "approve" || action === "request-reupload") {
    const rowButton = document.querySelector(
      `#admin-team-list button[data-action="${action}"][data-team-id="${CSS.escape(actionButton.dataset.teamId)}"]`,
    );
    rowButton?.click();
    if (rowButton?.disabled) paymentProofDialog.close();
  }
});

async function retryAdminEmail(button) {
  button.disabled = true;
  const { data, error } = await supabase.rpc("ideaforge_email_retry", {
    p_id: button.dataset.emailId,
  });
  if (error) {
    console.error("Could not retry IdeaForge confirmation email.", error);
    showToast(error.message || "Could not retry the confirmation email.", true);
    button.disabled = false;
    return;
  }
  if (data !== true) {
    await loadAdminDashboard();
    showToast("This email is no longer eligible for a safe retry.", true);
    return;
  }
  await loadAdminDashboard();
  showToast("Confirmation email queued for retry.", true);
}

document.querySelector("#send-gmail-queue").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!activeAdmin) {
    showToast("Sign in with an approved admin account first.", true);
    return;
  }
  if (!window.confirm("Send the next batch of due confirmation emails now?")) return;

  button.disabled = true;
  button.dataset.originalText = button.textContent;
  button.textContent = "Sending queued emails…";
  try {
    const { data, error } = await supabase.functions.invoke("ideaforge-email-worker", {
      body: {},
    });
    if (error) {
      console.error("Could not run the IdeaForge Gmail queue.", error.toJSON?.() ?? error);
      if (error instanceof FunctionsFetchError) {
        showToast(
          "The Gmail function could not be reached. Deploy the latest ideaforge-email-worker to Supabase and verify its CORS preflight is enabled.",
          true,
        );
      } else if (error instanceof FunctionsHttpError) {
        let detail = "The Gmail function returned an error.";
        try {
          const response = error.context;
          const body = await response.clone().json();
          detail = body.error || body.note || detail;
        } catch (parseError) {
          console.error("Could not read the Gmail function error response.", parseError);
        }
        showToast(`Gmail function error: ${detail}`, true);
      } else if (error instanceof FunctionsRelayError) {
        showToast("Supabase could not route the request to the Gmail function. Check its deployment and status.", true);
      } else {
        showToast(error.message || "Could not send queued confirmation emails.", true);
      }
      return;
    }
    if (data?.enabled !== true) {
      showToast(data?.note || "Gmail sending is disabled in Supabase.", true);
      return;
    }
    await loadAdminDashboard();
    showToast(
      `Gmail queue complete: ${data.sent} sent, ${data.failed} failed, ${data.retried} scheduled to retry.`,
      true,
    );
  } catch (error) {
    console.error("Unexpected error while sending the IdeaForge Gmail queue.", error);
    showToast("Could not send queued confirmation emails. Please try again.", true);
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.originalText || "✉ Send next batch now";
  }
});

document.querySelector("#admin-email-list").addEventListener("click", async (event) => {
  const button = event.target.closest('button[data-action="retry-email"]');
  if (button && activeAdmin) await retryAdminEmail(button);
});

document.querySelector(".admin-nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-page]");
  if (button) setAdminPage(button.dataset.adminPage);
});

document.querySelector("#admin-dashboard").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-admin-page]");
  if (button) setAdminPage(button.dataset.adminPage);
});

document.querySelector("#admin-menu-toggle").addEventListener("click", (event) => {
  const sidebar = document.querySelector("#admin-sidebar");
  const open = sidebar.classList.toggle("open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
});

document.querySelector("#admin-payment-search").addEventListener("input", filterAdminPayments);
document.querySelector("#admin-payment-filter").addEventListener("change", filterAdminPayments);
document.querySelector("#admin-email-search").addEventListener("input", filterAdminEmails);
document.querySelector("#toggle-participant-checkin").addEventListener("click", async (event) => {
  if (!activeAdmin || !supabase) {
    showToast("Sign in with an approved admin account first.", true);
    return;
  }
  const button = event.currentTarget;
  const status = document.querySelector("#participant-checkin-toggle-status");
  const nextValue = !adminCheckinEnabled;
  button.disabled = true;
  status.textContent = nextValue
    ? "Enabling participant check-in scanning…"
    : "Disabling participant check-in scanning…";
  const { data, error } = await supabase
    .from("ideaforge_settings")
    .update({
      participant_checkin_enabled: nextValue,
      updated_at: new Date().toISOString(),
      updated_by: activeAdmin.id,
    })
    .eq("id", true)
    .select("participant_checkin_enabled")
    .single();
  if (error || data?.participant_checkin_enabled !== nextValue) {
    console.error(
      "Could not update the participant check-in setting.",
      error ?? new Error("The updated setting was not returned."),
    );
    status.textContent = "Could not update the setting. Check admin permissions and try again.";
    button.disabled = false;
    return;
  }
  adminCheckinEnabled = nextValue;
  button.setAttribute("aria-pressed", String(adminCheckinEnabled));
  button.textContent = adminCheckinEnabled
    ? "Disable participant QR scanner"
    : "Enable participant QR scanner";
  button.disabled = false;
  status.textContent = adminCheckinEnabled
    ? "Participant check-in scanning is enabled."
    : "Participant check-in scanning is hidden from profiles.";
});
document.querySelector(".admin-outbox-filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-email-filter]");
  if (!button) return;
  activeEmailFilter = button.dataset.emailFilter;
  for (const tab of document.querySelectorAll(".admin-filter-tab")) {
    tab.classList.toggle("active", tab === button);
  }
  filterAdminEmails();
});
document.querySelector("#export-sent-emails").addEventListener("click", exportSentEmails);

document.querySelector("#admin-user-search").addEventListener("input", (event) => {
  filterAdminUsers(event.currentTarget.value);
});

document.querySelector("#refresh-email-outbox").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadAdminDashboard();
  } finally {
    button.disabled = false;
  }
});

function stopParticipantCheckinScanner() {
  if (participantCheckinScannerControls) {
    participantCheckinScannerControls.stop();
    participantCheckinScannerControls = null;
  }
  const video = document.querySelector("#participant-checkin-video");
  if (video) video.hidden = true;
  const startButton = document.querySelector("#start-participant-checkin-scanner");
  const stopButton = document.querySelector("#stop-participant-checkin-scanner");
  if (startButton) startButton.disabled = false;
  if (stopButton) stopButton.disabled = true;
}

document.querySelector("#stop-participant-checkin-scanner").addEventListener(
  "click",
  stopParticipantCheckinScanner,
);

document.querySelector("#start-participant-checkin-scanner").addEventListener("click", async (event) => {
  if (!participantUser || !activeParticipantTeam) {
    showToast("Sign in with the Google account registered on your team first.");
    return;
  }

  const startButton = event.currentTarget;
  const stopButton = document.querySelector("#stop-participant-checkin-scanner");
  const message = document.querySelector("#participant-checkin-message");
  const video = document.querySelector("#participant-checkin-video");
  startButton.disabled = true;
  video.hidden = false;
  message.textContent = "Starting camera…";
  try {
    const { BrowserQRCodeReader } = await import("@zxing/browser");
    const reader = new BrowserQRCodeReader();
    participantCheckinScannerControls = await reader.decodeFromVideoDevice(
      undefined,
      video,
      async (result) => {
        if (!result) return;
        const match = /^IDEAFORGE-CHECKIN:([0-9a-f-]{36})$/i.exec(result.getText().trim());
        stopParticipantCheckinScanner();
        if (!match) {
          message.textContent = "That is not a valid IdeaForge check-in QR. Scan the current QR shown by an admin.";
          return;
        }

        message.textContent = "Checking in your team…";
        const { data, error } = await supabase.rpc("ideaforge_check_in_my_team", {
          p_token: match[1],
        });
        if (error) {
          console.error("Could not check in the participant's IdeaForge team.", error);
          message.textContent = error.message || "Could not check in your team. Ask an admin for help.";
          return;
        }

        message.textContent = data.already_checked_in
          ? `Your team was already checked in at ${new Date(data.checked_in_at).toLocaleString()}.`
          : `Your team was checked in successfully · ${data.attendee_count} participants.`;
        await loadParticipantTeam(participantUser.id);
      },
    );
    stopButton.disabled = false;
    message.textContent = "Point your camera at the active check-in QR displayed by an admin.";
  } catch (error) {
    console.error("Could not start the participant check-in scanner.", error);
    message.textContent = error instanceof Error
      ? `Could not start camera: ${error.message}`
      : "Could not start camera. Check permissions and try again.";
    stopParticipantCheckinScanner();
  }
});

function renderAdminCheckinSearch() {
  const search = document.querySelector("#checkin-search");
  const results = document.querySelector("#checkin-search-results");
  if (!search || !results) return;
  const query = search.value.trim().toLowerCase();
  results.replaceChildren();

  if (!query) {
    const hint = document.createElement("p");
    hint.className = "prototype-note";
    hint.textContent = "Search by team name, team code, participant name, register no, or phone.";
    results.append(hint);
    return;
  }

  const matches = adminTeamsData.filter((team) => {
    const members = team.ideaforge_members ?? [];
    const searchable = [
      team.team_name,
      team.team_code,
      team.registration_type,
      ...members.flatMap((member) => [
        member.register_number,
        member.full_name,
        member.mobile_number,
        member.college_name,
      ]),
    ].join(" ").toLowerCase();
    return searchable.includes(query);
  }).slice(0, 20);

  if (matches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "prototype-note";
    empty.textContent = "No matching team. Try a different name, phone, or code.";
    results.append(empty);
    return;
  }

  for (const team of matches) {
    const item = document.createElement("article");
    item.className = "checkin-search-result";
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = team.team_name;
    const info = document.createElement("span");
    const contact = (team.ideaforge_members ?? []).find((member) => member.is_team_contact);
    info.textContent = `${team.team_code} · ${contact?.full_name ?? "Team"}`;
    details.append(name, info);
    const button = document.createElement("button");
    button.className = "small-button approve";
    button.type = "button";
    button.dataset.checkinCode = team.team_code;
    if (team.checked_in_at) {
      button.textContent = `Checked in · ${new Date(team.checked_in_at).toLocaleString()}`;
      button.disabled = true;
    } else {
      button.textContent = "Check in team";
    }
    item.append(details, button);
    results.append(item);
  }
}

document.querySelector("#checkin-search").addEventListener("input", renderAdminCheckinSearch);
document.querySelector("#checkin-search-results").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-checkin-code]");
  if (!button) return;
  if (!activeAdmin) {
    showToast("Sign in with an approved admin account first.", true);
    return;
  }

  const result = document.querySelector("#checkin-result");
  button.disabled = true;
  result.hidden = false;
  result.textContent = "Checking in team…";
  try {
    const { data, error } = await supabase.rpc("ideaforge_check_in_team", {
      p_team_code: button.dataset.checkinCode,
    });
    if (error) {
      console.error("Could not check in IdeaForge team.", error);
      result.textContent = error.message || "Could not check in this team.";
      button.disabled = false;
      return;
    }
    result.textContent = data.already_checked_in
      ? `${data.team_name} was already checked in at ${new Date(data.checked_in_at).toLocaleString()}.`
      : `${data.team_name} checked in successfully · ${data.attendee_count} participant${data.attendee_count === 1 ? "" : "s"}.`;
    await loadAdminDashboard();
  } catch (error) {
    console.error("Unexpected error checking in IdeaForge team.", error);
    result.textContent = "Check-in failed because of a network error. Please try again.";
    button.disabled = false;
  }
});

document.querySelector("#create-checkin-qr").addEventListener("click", async (event) => {
  if (!activeAdmin) {
    showToast("Sign in with an approved admin account first.", true);
    return;
  }

  const button = event.currentTarget;
  const canvas = document.querySelector("#admin-checkin-qr");
  const message = document.querySelector("#admin-checkin-qr-message");
  button.disabled = true;
  message.textContent = "Creating a secure check-in QR…";
  canvas.hidden = true;
  try {
    const { data, error } = await supabase.rpc("ideaforge_create_checkin_session");
    if (error) {
      console.error("Could not create an IdeaForge check-in session.", error);
      message.textContent = error.message || "Could not create the check-in QR. Please try again.";
      return;
    }
    if (!data?.token || !data?.expires_at) {
      throw new Error("The check-in session response is incomplete.");
    }

    await QRCode.toCanvas(canvas, `IDEAFORGE-CHECKIN:${data.token}`, {
      width: 280,
      margin: 2,
      color: { dark: "#090909", light: "#ffffff" },
    });
    canvas.hidden = false;
    message.textContent = `Participants can scan this QR until ${new Date(data.expires_at).toLocaleTimeString()}.`;
    button.textContent = "Refresh check-in QR";
  } catch (error) {
    console.error("Could not display the IdeaForge check-in QR.", error);
    message.textContent = error instanceof Error
      ? `Could not display QR: ${error.message}`
      : "Could not display the check-in QR. Please try again.";
  } finally {
    button.disabled = false;
  }
});

function isEmailQueueRoute() {
  return window.location.pathname.replace(/\/+$/, "").endsWith("/wasd4381/email");
}

function isCheckinToggleRoute() {
  return window.location.pathname.replace(/\/+$/, "").toLowerCase().endsWith("/wasd4381/email/qrtoggle");
}

function isQrDisplayRoute() {
  return window.location.pathname.replace(/\/+$/, "").toLowerCase().endsWith("/wasd4381/qr");
}

function isAdminRoute() {
  const path = window.location.pathname.replace(/\/+$/, "").toLowerCase();
  return path.endsWith("/wasd4381") || isEmailQueueRoute() || isCheckinToggleRoute() || isQrDisplayRoute() ||
    window.location.search === "?admin=wasd4381" ||
    window.location.hash === "#admin";
}

function renderRoute() {
  const admin = isAdminRoute();
  publicView.hidden = admin;
  adminView.hidden = !admin;
  adminView.classList.toggle("admin-email-only", isEmailQueueRoute());
  adminView.classList.toggle("admin-nested-route", isEmailQueueRoute() || isCheckinToggleRoute() || isQrDisplayRoute());
  adminView.classList.toggle("admin-checkin-toggle-only", isCheckinToggleRoute());
  adminView.classList.toggle("admin-qr-display-only", isQrDisplayRoute());
  if (admin) {
    void renderAdmin();
    return;
  }

  stopParticipantCheckinScanner();
  const isProfile = window.location.hash === "#profile";
  profilePage.hidden = !isProfile;
  if (isProfile) successPanel.hidden = true;
  if (isProfile && participantUser) {
    void loadParticipantTeam(participantUser.id);
  }
  for (const section of publicView.querySelectorAll("main > section:not(#profile):not(#profile-page)")) {
    section.hidden = isProfile;
  }
  if (!isProfile) {
    refreshRegistrationState();
  }

  if (isProfile) {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  } else if (window.location.hash && window.location.hash !== "#") {
    const targetElement = document.querySelector(window.location.hash);
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: "smooth" });
    }
  }
}

window.addEventListener("popstate", renderRoute);
window.addEventListener("hashchange", renderRoute);

document.addEventListener("click", (event) => {
  // 1. Any participant sign-in trigger:
  // - "Continue with Google" button in registration notice (#registration-google-sign-in)
  // - "Go to sign in" link in registration notice (#go-to-sign-in-link)
  // - "Continue with Google" button on profile page (#participant-google-sign-in)
  const signinButton = event.target.closest(
    "#registration-google-sign-in, #go-to-sign-in-link, #registration-auth-required a, #registration-auth-required button, #participant-google-sign-in"
  );
  if (signinButton) {
    event.preventDefault();
    const isRegister = signinButton.id === "registration-google-sign-in" ||
                       signinButton.id === "go-to-sign-in-link" ||
                       Boolean(signinButton.closest("#registration-auth-required"));
    void startParticipantGoogleSignIn(isRegister ? "register" : "profile");
    return;
  }

  // 2. Topbar "Sign in / Profile" link:
  // - If signed out: directly start Google sign-in!
  // - If signed in: navigate to profile page!
  const profileNavLink = event.target.closest("#profile-nav-link");
  if (profileNavLink) {
    event.preventDefault();
    if (!participantUser) {
      void startParticipantGoogleSignIn("profile");
      return;
    }
    if (window.location.hash !== "#profile") {
      window.location.hash = "#profile";
    } else {
      renderRoute();
    }
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    return;
  }

  // 3. Other links to #profile (e.g. "View your profile" when registered)
  const profileAnchor = event.target.closest('a[href="#profile"]');
  if (profileAnchor) {
    event.preventDefault();
    if (window.location.hash !== "#profile") {
      window.location.hash = "#profile";
    } else {
      renderRoute();
    }
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    return;
  }

  // 4. Links to #register (e.g. from profile page)
  const registerAnchor = event.target.closest('a[href="#register"]');
  if (registerAnchor && window.location.hash === "#profile") {
    event.preventDefault();
    window.location.hash = "#register";
    renderRoute();
    const target = document.querySelector("#register");
    if (target) {
      target.scrollIntoView({ behavior: "smooth" });
    }
  }
});

renderMembers();
updateRegistrationLinks();
renderRoute();

if ("IntersectionObserver" in window) {
  document.documentElement.classList.add("has-motion");
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 },
  );

  document.querySelectorAll(".reveal").forEach((element) => {
    revealObserver.observe(element);
  });
}
