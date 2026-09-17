{-# LANGUAGE TemplateHaskell #-}
module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.TH qualified as PlutusTx
import PlutusTx.Prelude qualified as Plinth

fibonacciCode :: CompiledCode (Integer -> Integer)
fibonacciCode = $$(PlutusTx.compile [||fibonacci||])

{-# INLINEABLE fibonacci #-}
fibonacci :: Integer -> Integer
fibonacci n
  | n Plinth.<= 1 = n
  | otherwise = fibonacci (n Plinth.- 1) Plinth.+ fibonacci (n Plinth.- 2)

main :: IO ()
main = pure ()
