import { Notice, PageHeader, Section } from '../../../../components/admin/bits';

export const metadata = { title: 'Growth guide' };

const card = `{"v":1,"layout":"stack","blocks":[{"type":"badge","text":"Test"},{"type":"heading","text":"Hello from the growth engine"},{"type":"text","text":"If you can read this, a campaign made it from the admin panel to the app."}]}`;

export default function GrowthGuide() {
  return (
    <>
      <PageHeader title="Run a campaign" subtitle="From nothing to a message in someone's app window, and how to tell when it does not show up." />
      <Notice icon="info">Do your first one on yourself: audience &quot;Only these people&quot; with just your own user id. Nobody else can see it, and you see at once whether the whole chain works.</Notice>

      <Section title="1. Create the campaign">
        <ol className="guide">
          <li>Open <a href="/admin/growth/campaigns">Campaigns</a>. In <b>New campaign</b> give it a name, kind <b>Promotion</b>, priority <b>100</b> (it wins over other promotions), and leave Starts blank (now).</li>
          <li>Set <b>Holdout %</b> to <b>0</b>. A holdout hides the campaign from that share of people on purpose; for a test you want to be in the group that sees it.</li>
          <li>Set <b>Max shows</b> to 100 and <b>Gap</b> to 0, so a test is not capped. Click <b>Create</b>.</li>
        </ol>
      </Section>

      <Section title="2. Add the creative (what people see)">
        <ol className="guide">
          <li>On the campaign page use the <b>chat empty</b> section: it is the card in a new, empty chat. <b>Kind</b>: Card. Paste this into the card box:
            <pre className="code">{card}</pre></li>
          <li>Click <b>Save draft</b>, then <b>Publish creative</b>. Only a published (ready) creative can be shown.</li>
          <li>Images and clips: <b>Upload</b>, wait for the worker to finish processing, then publish. The inbox and bottom strip take images but not video.</li>
        </ol>
      </Section>

      <Section title="3. Choose who sees it, then go live">
        <ol className="guide">
          <li>Find your user id: open <a href="/admin/users">Users</a>, open yourself, copy the id. Paste it in <b>Audience → Only these people</b> and click <b>Save audience</b>. Leave every other box empty (empty means everyone).</li>
          <li>Click <b>Go live</b>. It refuses until at least one creative is ready.</li>
        </ol>
      </Section>

      <Section title="4. See it in your window">
        <ol className="guide">
          <li>In the desktop app, signed in as that person, run <b>Developer: Reload Window</b> from the Command Palette. The app asks for promotions a few seconds after it starts (and again every five minutes).</li>
          <li>Open a new empty chat. The card shows in the welcome area. Click or dismiss it; those clicks appear on <a href="/admin/growth">Growth</a> within a minute.</li>
        </ol>
      </Section>

      <Section title="If it does not show up">
        <p className="muted">On the campaign page, <b>Would this person see it?</b>: enter your user id, placement <b>chat_empty</b>, press <b>Explain</b>. It names the first thing that stops it. The usual ones:</p>
        <div className="table-wrap"><table className="dt"><thead><tr><th>Reason</th><th>Fix</th></tr></thead><tbody>
          <tr><td>The campaign is not live, or outside its dates</td><td>Go live; check Starts and Ends.</td></tr>
          <tr><td>No ready creative on that placement</td><td>Publish the creative (clips need processed media).</td></tr>
          <tr><td>You are not in the audience</td><td>Wrong user id, or a plan, platform or app-version filter you did not mean to set.</td></tr>
          <tr><td>You are in the holdout</td><td>Holdout % above 0 hides it from a fixed share of people. Set it to 0.</td></tr>
          <tr><td>Frequency cap or dismissed</td><td>Raise Max shows, set Gap to 0. A person who dismissed a campaign never sees it again; make a new campaign to test again.</td></tr>
          <tr><td>Ad-free plan, or promotions switched off</td><td>Settings → promotions in the app, or the plan's ad-free entitlement.</td></tr>
          <tr><td>Kill switch on</td><td>The flag <code>killswitch.promotions</code> turns every promotion off. Turn it off on Feature flags.</td></tr>
          <tr><td>The window is signed out, or is an older app</td><td>Sign in. A creative made for a newer placement contract is never sent to an older app.</td></tr>
        </tbody></table></div>
        <p className="muted">Reading the numbers on <a href="/admin/growth">Growth</a>: <b>Served</b> is what the server handed out, <b>Impressions</b> is what the app showed, <b>Reached</b> is the share between them. Served but no impressions means the app got it and did not draw it.</p>
      </Section>

      <Section title="Before you aim it at everyone">
        <ul className="guide">
          <li>Aim at your own id first, then a small audience (one plan, one platform), then everyone.</li>
          <li>Set a real holdout (5 to 10 percent) when you want to know whether the campaign helps; compare the held-out group to the rest.</li>
          <li>Write a real headline and one clear button. Promotions are labelled &quot;Featured&quot; for people; release notes and task notices reach everyone, including people on ad-free plans.</li>
          <li>A campaign that is dismissed too often is paused for you automatically (over 35 percent dismissals after 50 impressions).</li>
          <li><b>Pause</b> stops it at once; <b>End</b> closes it. Everything you change is audited.</li>
        </ul>
        <p className="muted">Stuck? Ask the assistant (Help, top right): it answers from the admin guide.</p>
      </Section>
    </>
  );
}
