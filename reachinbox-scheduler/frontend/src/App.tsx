import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Clock3, Send, Search, RefreshCw, ChevronDown, LogOut, Settings, Link2, MonitorCog, Paperclip, Bold, Italic, Underline, Strikethrough, List, ListOrdered, Quote, Undo2, Redo2, ArrowLeft } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';
import Papa from 'papaparse';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import UnderlineExt from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';

axios.defaults.baseURL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
axios.defaults.withCredentials = true;

type User = { id: string; name: string; email: string; avatarUrl?: string };
type EmailJob = { id: string; recipientEmail: string; subject: string; textBody: string; htmlBody: string; status: string; scheduledAt: string; sentAt?: string; previewUrl?: string; failureReason?: string };

function useMe() {
  return useQuery<User | null>({ queryKey: ['me'], queryFn: async () => (await axios.get('/api/auth/me')).data });
}

function Login() {
  const devLogin = async () => {
    try { await axios.post('/api/auth/dev-login'); window.location.href = '/scheduled'; }
    catch { toast.error('Development login failed'); }
  };
  return <main className="login-page"><section className="login-card"><h1>Login</h1>
    <button className="google-button" onClick={() => window.location.href = `${axios.defaults.baseURL}/api/auth/google`}><span className="google-g">G</span> Login with Google</button>
    <div className="divider"><span>or sign up through email</span></div>
    <input className="login-input" disabled placeholder="Email ID" /><input className="login-input" disabled type="password" placeholder="Password" />
    <button className="login-button" onClick={devLogin}>Login</button>
  </section></main>;
}

function Sidebar({ active }: { active: 'scheduled' | 'sent' }) {
  const navigate = useNavigate();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const counts = useQuery({ queryKey: ['counts'], queryFn: async () => (await axios.get('/api/emails/counts')).data });
  const user = me.data;
  return <aside className="sidebar">
    <button className="profile-card" onClick={() => setOpen(v => !v)}>
      <div className="logo">ONB</div><div className="profile-row">
        {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="avatar">{user?.name?.[0] || 'U'}</span>}
        <span className="profile-copy"><strong>{user?.name || 'User'}</strong><small>{user?.email || ''}</small></span><ChevronDown size={15}/>
      </div>
    </button>
    {open && <div className="profile-menu">
      <button onClick={() => navigate('/compose')}><Settings size={15}/> Manage Senders</button>
      <button onClick={() => axios.get('/api/slack/connect').catch(e => toast.error(e.response?.data?.error || 'Slack unavailable'))}><Link2 size={15}/> Connect Slack</button>
      <button onClick={() => window.open('http://localhost:5000/admin/queues', '_blank')}><MonitorCog size={15}/> Queue Monitor</button>
      <button onClick={async () => { await axios.post('/api/auth/logout'); window.location.href = '/login'; }}><LogOut size={15}/> Logout</button>
    </div>}
    <button className="compose-button" onClick={() => navigate('/compose')}>Compose</button>
    <div className="nav-label">CORE</div>
    <nav><button className={active === 'scheduled' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('/scheduled')}><span><Clock3 size={15}/> Scheduled</span><b>{counts.data?.scheduled ?? 0}</b></button>
      <button className={active === 'sent' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('/sent')}><span><Send size={15}/> Sent</span><b>{counts.data?.sent ?? 0}</b></button></nav>
  </aside>;
}

function EmailList({ type }: { type: 'scheduled' | 'sent' }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: [type, search, page], queryFn: async () => (await axios.get(`/api/emails/${type}`, { params: { search, page, limit: 25 } })).data, refetchInterval: 10000 });
  const items: EmailJob[] = query.data?.items || [];
  return <div className="app-shell"><Sidebar active={type}/>
    <main className="mail-main"><header className="mail-toolbar"><label className="search-box"><Search size={16}/><input value={search} onChange={e => { setPage(1); setSearch(e.target.value); }} placeholder="Search"/></label>
      <button className="icon-button" title="Filter" onClick={() => toast('Showing all statuses')}><span className="filter-icon">▼</span></button><button className="icon-button" title="Refresh" onClick={() => query.refetch()}><RefreshCw size={16}/></button></header>
      {query.isLoading && <div className="empty-state">Loading emails...</div>}{query.isError && <div className="empty-state">Could not load emails.</div>}
      {!query.isLoading && !query.isError && items.length === 0 && <div className="empty-state">No {type} emails</div>}
      <div className="email-list">{items.map(job => <button className="email-row" key={job.id} onClick={() => navigate(`/emails/${job.id}`)}>
        <strong className="recipient">To: {job.recipientEmail}</strong>
        {type === 'scheduled' ? <span className={`time-badge ${job.status === 'RATE_LIMITED' ? 'limited' : ''}`}><Clock3 size={13}/>{new Date(job.scheduledAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}</span> : <span className={`sent-badge ${job.status.toLowerCase()}`}>{job.status === 'SENT' ? 'Sent' : job.status}</span>}
        <span className="email-copy"><b>{job.subject}</b><i> - {job.textBody?.slice(0, 100)}</i></span>
      </button>)}</div>
      {query.data?.total > 25 && <div className="pagination"><button disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button><span>{page}</span><button onClick={() => setPage(p => p + 1)}>Next</button></div>}
    </main></div>;
}

function EmailDetails() {
  const { id } = useParams(); const navigate = useNavigate();
  const query = useQuery({ queryKey: ['email', id], queryFn: async () => (await axios.get(`/api/emails/${id}`)).data });
  const job: EmailJob | undefined = query.data;
  if (query.isLoading) return <div className="details-page">Loading...</div>;
  if (!job) return <div className="details-page">Email not found</div>;
  return <div className="details-page"><header className="details-header"><button className="back-button" onClick={() => navigate(-1)}><ArrowLeft size={20}/> {job.subject}</button><span className={`sent-badge ${job.status.toLowerCase()}`}>{job.status}</span></header>
    <article className="message"><div className="message-meta"><span className="avatar sender-avatar">O</span><div><strong>{job.recipientEmail}</strong><small>to me</small></div><time>{job.sentAt ? new Date(job.sentAt).toLocaleString() : new Date(job.scheduledAt).toLocaleString()}</time></div>
      {job.previewUrl && <a className="preview-link" href={job.previewUrl} target="_blank" rel="noreferrer">Open Ethereal preview</a>} {job.failureReason && <div className="failure">Failure: {job.failureReason}</div>}
      <div className="message-body" dangerouslySetInnerHTML={{ __html: job.htmlBody || job.textBody }} /></article></div>;
}

function Compose() {
  const navigate = useNavigate(); const queryClient = useQueryClient();
  const senders = useQuery({ queryKey: ['senders'], queryFn: async () => (await axios.get('/api/senders')).data });
  const [senderId, setSenderId] = useState(''); const [recipientInput, setRecipientInput] = useState(''); const [recipients, setRecipients] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false); const [subject, setSubject] = useState(''); const [delay, setDelay] = useState(2); const [hourlyLimit, setHourlyLimit] = useState(100);
  const [scheduleOpen, setScheduleOpen] = useState(false); const [scheduledTime, setScheduledTime] = useState<Date | null>(null); const [submitting, setSubmitting] = useState(false); const [uploadStats, setUploadStats] = useState('');
  const editor = useEditor({ extensions: [StarterKit, UnderlineExt, TextAlign.configure({ types: ['heading', 'paragraph'] }), Placeholder.configure({ placeholder: 'Type Your Reply...' })], content: '' });
  useEffect(() => { if (senders.data?.length && !senderId) setSenderId(senders.data[0].id); }, [senders.data, senderId]);

  const addRecipient = (value: string) => { const email = value.trim().toLowerCase(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !recipients.includes(email)) setRecipients(v => [...v, email]); };
  const handleRecipientKey = (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addRecipient(recipientInput); setRecipientInput(''); } };
  const uploadRecipients = (file?: File) => {
    if (!file) return;
    Papa.parse<string[]>(file, { complete: result => { const values = result.data.flatMap(row => row.map(v => String(v).trim()).filter(v => v)); const unique = [...new Set(values.filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)).map(v => v.toLowerCase()))]; setRecipients(v => [...new Set([...v, ...unique])]); setUploadStats(`${unique.length} accepted recipients`); } });
  };
  const submit = async () => {
    if (!senderId) return toast.error('Configure a sender first'); if (!recipients.length) return toast.error('Add at least one recipient'); if (!subject.trim()) return toast.error('Enter a subject');
    setSubmitting(true);
    try {
      await axios.post('/api/emails/schedule', { senderId, recipients, subject, textBody: editor?.getText() || '', htmlBody: editor?.getHTML() || '', startTime: scheduledTime ? scheduledTime.toISOString() : new Date().toISOString(), delayBetweenEmailsMs: delay * 1000, hourlyLimit }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
      toast.success(scheduledTime ? 'Email scheduled' : 'Email queued'); queryClient.invalidateQueries(); navigate('/scheduled');
    } catch (error: any) { toast.error(error.response?.data?.error || 'Scheduling failed'); } finally { setSubmitting(false); }
  };
  const displayed = showAll ? recipients : recipients.slice(0, 3);
  return <main className="compose-page"><header className="compose-header"><button className="back-button" onClick={() => navigate(-1)}><ArrowLeft size={20}/> Compose New Email</button><div className="compose-actions"><button className="icon-button" title="Attach" onClick={() => toast('Attachments are not implemented')}><Paperclip size={17}/></button><button className="icon-button" title="Schedule" onClick={() => setScheduleOpen(v => !v)}><Clock3 size={17}/></button><button className={`send-button ${scheduledTime ? 'later' : ''}`} disabled={submitting} onClick={submit}>{scheduledTime ? 'Send Later' : 'Send'}</button></div></header>
    {scheduleOpen && <SchedulePopover onCancel={() => setScheduleOpen(false)} onDone={time => { setScheduledTime(time); setScheduleOpen(false); }}/>}
    <section className="compose-content"><div className="field-row"><label>From</label><select value={senderId} onChange={e => setSenderId(e.target.value)}>{senders.data?.map((sender: any) => <option value={sender.id} key={sender.id}>{sender.email}</option>)}</select></div>
      <div className="field-row recipient-row"><label>To</label><div className="recipient-editor"><input value={recipientInput} onChange={e => setRecipientInput(e.target.value)} onKeyDown={handleRecipientKey} placeholder="recipient@example.com"/></div><label className="upload-link"><Paperclip size={15}/> Upload List<input type="file" accept=".csv,.txt" onChange={e => uploadRecipients(e.target.files?.[0])}/></label></div>
      {recipients.length > 0 && <div className="recipient-chips">{displayed.map(email => <button className="recipient-chip" key={email} onClick={() => setRecipients(v => v.filter(v => v !== email))}>{email}</button>)}{recipients.length > 3 && <button className="recipient-chip" onClick={() => setShowAll(v => !v)}>+{recipients.length - (showAll ? 0 : 3)}</button>}{uploadStats && <small>{uploadStats}</small>}</div>}
      <div className="field-row subject-row"><label>Subject</label><input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject"/></div>
      <div className="compose-controls"><span>Delay between 2 emails</span><input type="number" min={2} value={delay} onChange={e => setDelay(Number(e.target.value))}/><small>seconds</small><span>Hourly Limit</span><input type="number" min={1} value={hourlyLimit} onChange={e => setHourlyLimit(Number(e.target.value))}/></div>
      {scheduledTime && <div className="scheduled-label">Scheduled: {scheduledTime.toLocaleString()}</div>}
      <div className="editor-wrap"><div className="format-toolbar"><button onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={16}/></button><button onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={16}/></button><button onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16}/></button><button onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16}/></button><button onClick={() => editor?.chain().focus().toggleUnderline().run()}><Underline size={16}/></button><button onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough size={16}/></button><button onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16}/></button><button onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={16}/></button><button onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={16}/></button></div><EditorContent editor={editor}/></div>
    </section></main>;
}

function SchedulePopover({ onCancel, onDone }: { onCancel: () => void; onDone: (time: Date) => void }) {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const [value, setValue] = useState('');
  const preset = (hour: number) => { const d = new Date(tomorrow); d.setHours(hour, 0, 0, 0); onDone(d); };
  return <aside className="schedule-popover"><h3>Send Later</h3><input type="datetime-local" value={value} onChange={e => setValue(e.target.value)} />
    <button onClick={() => onDone(tomorrow)}>Tomorrow</button><button onClick={() => preset(10)}>Tomorrow, 10:00 AM</button><button onClick={() => preset(11)}>Tomorrow, 11:00 AM</button><button onClick={() => preset(15)}>Tomorrow, 3:00 PM</button>
    <footer><button onClick={onCancel}>Cancel</button><button className="done" onClick={() => value ? onDone(new Date(value)) : onDone(tomorrow)}>Done</button></footer></aside>;
}

function Protected({ children }: { children: React.ReactNode }) {
  const me = useMe(); if (me.isLoading) return <div className="login-page"><div>Loading...</div></div>; if (!me.data) return <Navigate to="/login" replace />; return <>{children}</>;
}

export default function App() {
  return <BrowserRouter><Toaster position="top-right"/><Routes>
    <Route path="/login" element={<Login/>}/><Route path="/" element={<Navigate to="/scheduled" replace/>}/>
    <Route path="/scheduled" element={<Protected><EmailList type="scheduled"/></Protected>}/><Route path="/sent" element={<Protected><EmailList type="sent"/></Protected>}/>
    <Route path="/emails/:id" element={<Protected><EmailDetails/></Protected>}/><Route path="/compose" element={<Protected><Compose/></Protected>}/>
  </Routes></BrowserRouter>;
}
