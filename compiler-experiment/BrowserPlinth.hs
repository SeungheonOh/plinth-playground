{-# LANGUAGE TemplateHaskell #-}
{-# OPTIONS_GHC -fplugin-opt Plinth.Plugin:dump-uplc #-}

module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.TH (compile)
import PlutusTx.Prelude qualified as Plinth

addOne :: Integer -> Integer
addOne x = x Plinth.+ 1

compiledAddOne :: CompiledCode (Integer -> Integer)
compiledAddOne = $$(compile [||addOne||])

main :: IO ()
main = putStrLn "BROWSER_MAIN_RAN"
