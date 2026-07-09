import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Home from '@/pages/Home'
import ChatGraphEditor from '@/pages/editor/ChatGraphEditor'

import "@blueprintjs/core/lib/css/blueprint.css";
import "./App.css"

function App() {
  return (
    <div className='relative h-full'>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/editor/:id" element={<ChatGraphEditor />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </div>
  )
}

export default App