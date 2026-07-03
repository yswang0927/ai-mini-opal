import { useState } from 'react';

export default function Sidebar() {
    const [selectedTab, setSelectedTab] = useState('Preview');

    return (
        <div className="editor-side">
            <div className="editor-side-header">
                <div className="editor-side-nav">
                    <button className={selectedTab === 'Preview' ? 'selected' : ''} onClick={() => setSelectedTab('Preview')}>Preview</button>
                    <button className={selectedTab === 'Console' ? 'selected' : ''} onClick={() => setSelectedTab('Console')}>Console</button>
                    <button className={selectedTab === 'Step' ? 'selected' : ''} onClick={() => setSelectedTab('Step')}>Step</button>
                    <button className={selectedTab === 'Theme' ? 'selected' : ''} onClick={() => setSelectedTab('Theme')}>Theme</button>
                </div>
            </div>

            <div className="editor-side-body">
                <div className="empty-state">Your app will appear here once it's built</div>
            </div>
        </div>
    );
}