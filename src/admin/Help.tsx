import type { ReactNode } from 'react';
import { STAGING } from '../lib/env';
import { atLeast, type Role } from '../../shared/permissions';

// The admin user manual: what each tab is for and how to do everyday tasks.
// Keep it in step with the tabs in AdminApp.tsx.

interface Topic { id: string; title: string; who?: string; min?: Role; body: ReactNode }

const TASKS: Topic[] = [
  {
    id: 'task-approve', title: 'Answer a new booking request',
    body: (
      <ol>
        <li>Open <b>Day</b>. New requests are at the top under <b>Waiting for you</b>.</li>
        <li><b>Approve</b> confirms it and emails the customer a confirmation with a calendar file.</li>
        <li><b>Propose new time</b> picks another date/time; the customer is emailed the new time.</li>
        <li><b>Decline</b> asks for a reason, which goes to the customer. For a change request, their original appointment stays.</li>
      </ol>
    ),
  },
  {
    id: 'task-block', title: 'Block off part of a day (tech out, long job)',
    body: (
      <ol>
        <li>On <b>Day</b>, go to the date and click <b>Block time</b>.</li>
        <li>Pick the start and end, add a reason (only staff see it), and tick <b>Repeat every week</b> for a standing block.</li>
        <li>Customers can’t book online in that time. Existing bookings stay; you can still book over it by phone.</li>
      </ol>
    ),
  },
  {
    id: 'task-close', title: 'Close the shop for a day or a week',
    body: <p><b>Settings → Closures</b>: pick the first and last day and a reason. Bookings already on those days are not cancelled, so check the Day view and call those customers.</p>,
  },
  {
    id: 'task-service', title: 'Change how long a job takes, or add a service',
    body: <p><b>Settings → Services</b>: edit the card and click <b>Save</b>. “How long it takes” decides which times are open. Untick <b>Offered online</b> to hide a service. <b>+ Add a service</b> is at the bottom.</p>,
  },
  {
    id: 'task-phone', title: 'Book someone who calls in',
    body: <p><b>Phone booking</b>: search the customer (or type a new one), pick services, date, wait or drop-off, and time. Leave “Email the customer” ticked to send them a confirmation. You can book over the normal limits; the app asks you to confirm first.</p>,
  },
  {
    id: 'task-done', title: 'Mark a job done, a no-show, or cancel',
    body: <p>On <b>Day</b>, click the booking. Use <b>Mark completed</b> (this starts the clock for that customer’s next service reminder), <b>No-show</b>, or <b>Cancel</b> (emails the customer). <b>Reopen as confirmed</b> undoes these, and checks the time is still free first.</p>,
  },
  {
    id: 'task-find', title: 'Find a booking',
    body: <p>On <b>Day</b>, type a name, phone number or email into <b>Find a booking</b> at the top. Click a result to jump to that day with the booking open.</p>,
  },
  {
    id: 'task-excel', title: 'Update services or settings in Excel',
    body: <p><b>Export → Download workbook</b>, edit the blue tabs in Excel, save, then <b>Export → Upload changes</b>. Check the list of changes it shows, then click <b>Save</b>.</p>,
  },
  {
    id: 'task-print', title: 'Print the day’s schedule',
    body: <p>On <b>Day</b>, go to the date and click <b>Print day</b>. You get a plain list: time, wait or drop-off, customer, phone, vehicle, services and notes.</p>,
  },
  {
    id: 'task-move', title: 'Move a booking',
    body: <p>Drag it to a new time on the Day timeline (or into the Drop-offs box), then choose <b>Move and email customer</b> or <b>Move, don’t email</b>. Or click it and use <b>Move</b> to pick any date and time.</p>,
  },
];

const TABS: Topic[] = [
  {
    id: 'tab-day', title: 'Day',
    body: (
      <>
        <p>Your home screen.</p>
        <ul>
          <li><b>Waiting for you</b>: requests to approve, propose a new time for, or decline. Change requests show the old and new time side by side. Auto-confirmed bookings you can still undo are listed under it.</li>
          <li><b>The timeline</b>: one row per lane. Waiters are placed at their time; yellow = requested (holding the slot), blue = confirmed. Grey striped bands are blocked time. Click an empty spot to book a waiter there.</li>
          <li><b>Drop-offs</b>: the cars being dropped off that day, with their drop-off time.</li>
          <li><b>Find a booking</b>: search by name, phone or email across all dates.</li>
          <li><b>Top bar</b>: change day with the arrows, <b>Today</b>, or the date box. <b>Block time</b> blocks part of the day; <b>Print day</b> prints the schedule. The capacity numbers show how full the day is.</li>
        </ul>
        <p>The page refreshes itself every minute, so it’s safe to leave open on the shop iPad.</p>
      </>
    ),
  },
  { id: 'tab-phone', title: 'Phone booking', body: <p>Book a customer who calls or walks in. See “Book someone who calls in” above.</p> },
  {
    id: 'tab-customers', title: 'Customers',
    body: (
      <ul>
        <li>Search by name, phone or email; tick <b>plate</b> to search by license plate.</li>
        <li>Open a customer to edit their details, vehicles, and contact preferences (email/mail opt-out, bounced, address undeliverable, “always review their bookings”).</li>
        <li>See their bookings, service history and the reminders they were sent.</li>
        <li><b>Merge into this customer</b> combines a duplicate record into this one. If it was a mistake, <b>Undo merge</b> on the same page puts both records back.</li>
        <li>Click a booking’s date to open it on the Day view. <b>Delete</b> next to a vehicle removes a sold car and its service history, so reminders for it stop.</li>
        <li><b>Forget this customer</b> (bottom of the page) is for someone who asks to be removed: their details, vehicles and history are deleted and upcoming appointments cancelled. It can’t be undone.</li>
      </ul>
    ),
  },
  {
    id: 'tab-approvals', who: 'Owner and developer', min: 'owner', title: 'Approvals',
    body: (
      <>
        <p>Decides which bookings need your OK, per service. Every service starts at step 1.</p>
        <ul>
          <li><b>1 · Approve</b>: you approve each booking.</li>
          <li><b>2 · Confirm &amp; notify</b>: bookings confirm themselves and you get an email; you can undo for a while.</li>
          <li><b>3 · Confirm &amp; digest</b>: bookings confirm themselves and you get a daily summary.</li>
        </ul>
        <p>The app suggests moving up once your history shows you always approve that service. Nothing moves unless you click <b>Move up</b>. Declines, proposed times and undos reset the count.</p>
      </>
    ),
  },
  {
    id: 'tab-postcards', who: 'Owner and developer', min: 'owner', title: 'Postcards',
    body: <p>Service-due reminder postcards collect here each week. Review the batch and click <b>Approve and send</b> to mail them (each postcard costs money). A big batch may stop partway; click <b>Continue sending</b> to finish it (nothing is mailed twice). <b>Template</b> edits the front and back design. <b>Past batches</b> shows what was mailed.</p>,
  },
  {
    id: 'tab-settings', who: 'Owner and developer', min: 'owner', title: 'Settings',
    body: (
      <ul>
        <li><b>Services</b>: what customers can book, how long each takes, daily limits, extra notice, reminder interval, whether customers can wait.</li>
        <li><b>Hours</b>: open and close time for each weekday.</li>
        <li><b>Closures</b> and <b>Blocked time</b>: whole days off, and parts of days.</li>
        <li><b>Shop</b>: name, phone, address (printed in every email), logo and color.</li>
        <li><b>Capacity</b>: lanes, waiter lanes, time steps, earliest and latest drop-off, how far ahead people can book.</li>
        <li><b>Approvals</b>: what needs review, response-time promises, when you and the owner get reminded, change cutoff, limits.</li>
        <li><b>Notifications &amp; reminders</b>: who gets staff emails, appointment reminder timing, dry-run mode for service reminders.</li>
        <li><b>Service reminder steps</b>: when reminder emails and postcards go out relative to the due date.</li>
      </ul>
    ),
  },
  {
    id: 'tab-activity', title: 'Activity',
    body: <p>A record of everything that happened: <b>Changes</b> (who changed what, before and after), <b>Reminders</b> sent, <b>Emails</b> sent and whether they failed, and <b>Scheduled jobs</b> (the daily and hourly runs, with any errors). Type in the filter box to narrow any list; <b>Show older</b> loads more. Times are shop time.</p>,
  },
  {
    id: 'tab-export', who: 'Owner and developer', min: 'owner', title: 'Export',
    body: (
      <>
        <p><b>Download workbook</b> gives you everything as one Excel file. Blue tabs (Services, Hours, Closures, Blocked time, Reminder steps, Settings) can be edited; grey tabs (Customers, Vehicles, Service history, Bookings) are for reference and analysis.</p>
        <p>To make changes in Excel: edit the blue tabs, save, then <b>Upload changes</b>. You’ll see every change before anything is saved. Keep the id column as it is; add a row (with no id) for something new; delete a row to remove a closure or blocked time, or to turn off a service or reminder step. Tabs left out of the file are left alone.</p>
        <p>The file contains customer personal information: store it carefully.</p>
      </>
    ),
  },
  {
    id: 'tab-team', title: 'Team', who: 'Owner and developer', min: 'owner',
    body: (
      <>
        <p>Who can sign in, and what they can do:</p>
        <ul>
          <li><b>Staff</b>: requests, the schedule, customers, phone bookings, blocked time, activity.</li>
          <li><b>Owner</b>: everything staff can, plus services, hours, closures, settings, approvals, postcards, export/import and the team.</li>
          <li><b>Developer</b>: everything, including technical settings (timezone, sign-in timeout, sender address, alert emails, rate limits, postcard design code) and the test tools. Only a developer can add, change or remove a developer.</li>
        </ul>
        <p><b>Send invite</b> emails a set-password link (and shows it so you can text it too). <b>Reset authenticator</b> is for a lost or new phone. <b>Remove</b> stops them signing in. You can’t change your own role or remove yourself.</p>
      </>
    ),
  },
  {
    id: 'tab-checklist', title: 'Checklist', who: 'Developer', min: 'developer',
    body: <p>The launch checklist from code audits. Tick items as they’re done; add notes or decisions under <b>Details</b>. To rerun the audit, type <b>/audit</b> in Claude Code in the project folder: new problems are added and fixed ones are flagged.</p>,
  },
];

const STAGING_TABS: Topic[] = [
  {
    id: 'tab-lab', title: 'Test lab', who: 'Developer, test site only', min: 'developer',
    body: <p>Play the customer and the shop at once. <b>Open customer phone</b> opens the booking page in a phone-sized window. Every email appears in the feed on the left (marked To customer / To Chris / To owner); links in an email open in the phone. The shop’s Day view is on the right. <b>Run</b> under Reminders runs the daily jobs for a date, to see reminder emails.</p>,
  },
  {
    id: 'tab-outbox', title: 'Outbox', who: 'Developer, test site only', min: 'developer',
    body: <p>Every email the test site would have sent, exactly as the recipient would see it. Nothing is delivered, except a [TEST] copy to artsscheduler@gmail.com.</p>,
  },
  {
    id: 'tab-simulator', title: 'Simulator', who: 'Developer, test site only', min: 'developer',
    body: <p>Fills the test site with fake customers (@sim.invalid addresses) and booking requests, and fast-forwards days to see reminders and postcards. <b>Reset simulated data</b> removes everything fake.</p>,
  },
];

function Section({ t }: { t: Topic }) {
  return (
    <section id={t.id} className="help-topic">
      <h3>{t.title}{t.who && <span className="help-who">{t.who}</span>}</h3>
      {t.body}
    </section>
  );
}

export function Help({ role }: { role: Role }) {
  const tabs = [...TABS, ...(STAGING ? STAGING_TABS : [])].filter((t) => atLeast(role, t.min ?? 'staff'));
  return (
    <div className="help-page">
      <h2>How to use the admin</h2>
      <p className="muted">Everyday tasks first, then what every tab does.</p>
      <nav className="help-toc" aria-label="Contents">
        <div><strong>Everyday tasks</strong>{TASKS.map((t) => <a key={t.id} href={`#${t.id}`}>{t.title}</a>)}</div>
        <div><strong>Tabs</strong>{tabs.map((t) => <a key={t.id} href={`#${t.id}`}>{t.title}</a>)}</div>
      </nav>
      <div className="settings-section">
        <h2>Everyday tasks</h2>
        {TASKS.map((t) => <Section key={t.id} t={t} />)}
      </div>
      <div className="settings-section">
        <h2>The tabs</h2>
        {tabs.map((t) => <Section key={t.id} t={t} />)}
      </div>
      <div className="settings-section">
        <h2>Good to know</h2>
        <ul>
          <li>Sign-in needs your password and the 6-digit code from your authenticator app. You’re signed out automatically after the time set in Settings (12 hours by default).</li>
          <li>Customers can change or cancel online until the change cutoff (Settings → Approvals). After that they’re told to call.</li>
          <li>Everything you change is recorded in Activity, with your name.</li>
        </ul>
      </div>
    </div>
  );
}
