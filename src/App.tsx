import { useState } from 'react'
import UpdateElectron from '@/components/update'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className='relative min-h-screen overflow-hidden bg-slate-50 px-4 py-8 text-slate-900 sm:px-6 lg:px-8'>
      <div className='relative mx-auto flex w-full max-w-6xl flex-col gap-8'>

        <div className='relative overflow-hidden rounded-[1.75rem] border border-slate-200 bg-gradient-to-br from-cyan-50 to-white p-6'>
          <div className='relative space-y-4'>
            <div className='text-5xl text-slate-900'>{count}</div>
            <button
              onClick={() => setCount((value) => value + 1)}
              className='inline-flex items-center justify-center rounded-2xl bg-cyan-500 px-5 py-3 text-white transition hover:bg-cyan-600'
            >
              Increment counter
            </button>
          </div>
        </div>

        <UpdateElectron />
      </div>
    </div>
  )
}

export default App